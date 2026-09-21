import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import * as state from './state.js'

// render: the one place a value is written to disk in the clear, for tools
// that only read their credentials from a config file (2026-09-21 vault
// design §6). The AI writes a template holding placeholders; the daemon fills
// it in. Everything here is about keeping that file from going anywhere it
// should not: not over a file someone wrote by hand, not into git, not past
// the command or slot it was rendered for.
//
// It is still plaintext on disk. What it guards against is an accident; an AI
// that sets out to read the file with a script of its own is not stopped here
// (§8), which is why render comes last in the order SKILL.md teaches.

export const PLACEHOLDER_RE = /\{\{\s*mp:([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g
const FILTERS = {
  raw: (v) => v,
  json: (v) => JSON.stringify(v),
  url: (v) => encodeURIComponent(v),
}
export const FILTER_NAMES = Object.keys(FILTERS)

export function normPath(p, { platform = process.platform } = {}) {
  const r = resolve(String(p))
  return platform === 'win32' ? r.toLowerCase() : r
}

export const samePath = (a, b) => normPath(a) === normPath(b)

// `TPL=OUT`. Split on `=`, not `:` — a Windows path already has a colon.
export function parseRenderSpec(spec, cwd = process.cwd()) {
  const s = String(spec ?? '')
  const i = s.indexOf('=')
  if (i <= 0 || i === s.length - 1) {
    return { error: `bad render target ${JSON.stringify(s)}: use TEMPLATE=OUTPUT, e.g. config.yml.tpl=config.yml` }
  }
  return { template: resolve(cwd, s.slice(0, i)), out: resolve(cwd, s.slice(i + 1)) }
}

export function isInside(root, p) {
  if (!root) return true
  const rel = relative(normPath(root), normPath(p))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// Fills the template, or refuses outright: an unknown name or filter, or
// anything that looks like a placeholder and is not one, means nothing is
// written — a config with a literal `{{mp:DB_PASS}}` in it fails later and
// far less clearly.
export function renderTemplate(text, values) {
  const src = String(text)
  const unknown = new Set()
  const badFilter = new Set()
  const out = src.replace(PLACEHOLDER_RE, (m, name, filter = 'raw') => {
    if (!FILTERS[filter]) {
      badFilter.add(filter)
      return m
    }
    if (!Object.hasOwn(values, name)) {
      unknown.add(name)
      return m
    }
    return FILTERS[filter](String(values[name]))
  })
  if (badFilter.size) {
    throw new Error(`unknown filter ${[...badFilter].map((f) => `|${f}`).join(', ')} — use |json or |url, or none`)
  }
  if (unknown.size) {
    throw new Error(`the template names ${[...unknown].join(', ')}, which this slot does not hold. `
      + `Placeholders must be one of: ${Object.keys(values).join(', ') || '(none)'}`)
  }
  const leftover = src.replace(PLACEHOLDER_RE, '').match(/\{\{\s*mp:[^}]*\}?\}?/)
  if (leftover) {
    throw new Error(`malformed placeholder ${JSON.stringify(leftover[0])} — the form is {{mp:NAME}}, {{mp:NAME|json}} or {{mp:NAME|url}}`)
  }
  return out
}

function nearestExisting(dir) {
  let d = dir
  while (!existsSync(d)) {
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
  return d
}

function hasGitAbove(dir) {
  let d = dir
  for (;;) {
    if (existsSync(join(d, '.git'))) return true
    const up = dirname(d)
    if (up === d) return false
    d = up
  }
}

// A config file with a real key in it being committed is the commonest way a
// key leaks for real, so inside a work tree the output must be ignored and
// untracked. Returns the reason to refuse, or null.
export function gitProblem(out, { spawnSyncFn = spawnSync } = {}) {
  const cwd = nearestExisting(dirname(out))
  if (!cwd) return `cannot render to ${out}: no part of that path exists`
  const git = (args) => spawnSyncFn('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })

  let inside
  try {
    inside = git(['rev-parse', '--is-inside-work-tree'])
  } catch {
    inside = null
  }
  if (!inside || inside.error) {
    return hasGitAbove(cwd)
      ? `cannot render to ${out}: it is inside a git repository and git is not available to check .gitignore`
      : null
  }
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null

  if (git(['ls-files', '--error-unmatch', '--', out]).status === 0) {
    return `${out} is tracked by git. A file holding a real key must never be committed: `
      + '`git rm --cached` it, add it to .gitignore, and render again.'
  }
  if (git(['check-ignore', '-q', '--', out]).status !== 0) {
    return `${out} is not ignored by git. Add it to .gitignore first — a config file with a real key in it `
      + 'is the most common way keys end up in a repository.'
  }
  return null
}

// Every path mp has rendered and still answers for: live slots' records and
// the files the user asked to keep. Only these may be overwritten.
export function knownRenderedPaths() {
  const out = []
  for (const s of state.listSecrets()) for (const f of s.renderedFiles || []) out.push(f.path)
  for (const f of state.readKeptFiles()) out.push(f.path)
  return out
}

export function recordKept(rec) {
  state.writeKeptFiles((files) => [...files.filter((f) => !samePath(f.path, rec.path)), rec])
}

// Deletes the kept files of one project and forgets them. Returns the paths.
export function removeKeptFor(root) {
  const mine = state.readKeptFiles().filter((f) => f.project && samePath(f.project, root))
  for (const f of mine) removeRendered(f.path)
  if (mine.length) state.writeKeptFiles((files) => files.filter((f) => !mine.some((m) => samePath(m.path, f.path))))
  return mine.map((f) => f.path)
}

export function writeRendered(out, content, { platform = process.platform } = {}) {
  mkdirSync(dirname(out), { recursive: true })
  const tmp = `${out}.${process.pid}.${randomBytes(3).toString('hex')}.mp-tmp`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, out)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  // POSIX: owner only. On Windows a project under the user's profile is
  // already private to them, and stripping inherited ACLs could lock out a
  // service that legitimately reads the file (design §6.4).
  if (platform !== 'win32') chmodSync(out, 0o600)
  return createHash('sha256').update(content).digest('hex').slice(0, 8)
}

export function removeRendered(path) {
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}
