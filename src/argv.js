import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

// A use is approved as an argv, never as a shell string: what the user ticked
// on the phone is a list of words, and a list of words cannot grow a `&&`.
// This file turns the string the user saw into that list, compares lists, and
// spawns one without ever handing it to a shell.

const DQ = '"'
const SQ = "'"

export function tokenize(text) {
  const out = []
  let cur = null
  let quote = null
  const s = String(text ?? '')

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    const next = s[i + 1]
    if (quote) {
      if (c === quote) {
        quote = null
      } else if (c === '\\' && quote === DQ && (next === DQ || next === '\\')) {
        cur += next
        i += 1
      } else {
        cur += c
      }
      continue
    }
    if (c === DQ || c === SQ) {
      quote = c
      cur = cur ?? ''
      continue
    }
    if (c === '\\' && (next === DQ || next === SQ || next === '\\' || next === ' ')) {
      cur = (cur ?? '') + next
      i += 1
      continue
    }
    if (/\s/.test(c)) {
      if (cur !== null) {
        out.push(cur)
        cur = null
      }
      continue
    }
    cur = (cur ?? '') + c
  }
  if (quote) throw new Error(`unbalanced ${quote} quote in ${JSON.stringify(s)}`)
  if (cur !== null) out.push(cur)
  return out
}

export function argvEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length
    && a.every((x, i) => x === b[i])
}

// Exact match only. Not a prefix, not a subsequence: `npm run deploy` was
// approved, `npm run deploy -- --dump-env` was not.
export function findApprovedUse(uses, argv) {
  for (const use of uses || []) {
    let tokens
    try {
      tokens = tokenize(use)
    } catch {
      continue
    }
    if (argvEqual(tokens, argv)) return use
  }
  return null
}

const WIN = process.platform === 'win32'

function pathext(env) {
  const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
  return raw.split(';').filter(Boolean).map((e) => e.toLowerCase())
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isBatch(p) {
  return ['.cmd', '.bat'].includes(extname(p).toLowerCase())
}

// Windows has no execve that understands PATHEXT: `npm` on disk is npm.cmd,
// and Node refuses to spawn a .cmd without a shell (CVE-2024-27980). So the
// executable is located here, PATHEXT-aware, and batch files go through
// cmd.exe with every argument quoted by hand rather than through `shell:
// true` with a string someone else could have shaped.
export function resolveExecutable(name, env = process.env, { win = WIN } = {}) {
  if (!win) return { file: name, batch: false }

  const exts = pathext(env)
  const hasExt = exts.includes(extname(name).toLowerCase())
  // Never the bare name: `C:\Program Files\nodejs\npm` exists (a shell script
  // for Git Bash users) right next to npm.cmd, and CreateProcess cannot run
  // it. Only an extension in PATHEXT makes a file executable here.
  const candidates = (base) => (hasExt ? [base] : exts.map((e) => base + e))

  if (isAbsolute(name) || /[\\/]/.test(name)) {
    const found = candidates(name).find(isFile) || name
    return { file: found, batch: isBatch(found) }
  }

  for (const dir of (env.PATH || env.Path || '').split(delimiter)) {
    if (!dir) continue
    const found = candidates(join(dir, name)).find(isFile)
    if (found) return { file: found, batch: isBatch(found) }
  }
  return { file: name, batch: isBatch(name) }
}

// The quoting cmd.exe and the C runtime agree on: wrap in double quotes,
// double the backslashes that precede a quote, escape the quote itself.
export function quoteForCmd(arg) {
  const s = String(arg)
  if (s !== '' && !/[\s"&|<>^()%!]/.test(s)) return s
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

export function spawnArgv(argv, {
  cwd, env = process.env, spawnFn = spawn, win = WIN,
} = {}) {
  const [name, ...args] = argv
  const { file, batch } = resolveExecutable(name, env, { win })
  const base = { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }

  if (!batch) return spawnFn(file, args, base)

  const line = [file, ...args].map(quoteForCmd).join(' ')
  // /d skips AutoRun, /s makes cmd strip exactly the outer quotes we add.
  return spawnFn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    ...base, windowsVerbatimArguments: true,
  })
}
