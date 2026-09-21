// The third line of defence for `mp secret run`, and knowingly the weakest:
// a handful of patterns for the crudest ways a run could be turned into a
// dump of its own environment. The first two lines are structural and live
// in the CLI — the daemon never returns a value, and only an argv the user
// ticked on the phone can run at all. This hook exists because a PreToolUse
// `deny` is the one control that still holds in bypassPermissions mode,
// where settings.json deny rules do not apply and a hook `ask` has no
// reliable prompt to land in (design §2.1, §6.1).
//
// It is heuristic. It will miss things. Its false positives are cheap: the
// model sees the reason and rewrites the command without the shell wrapper.
//
// Since the vault (2026-09-21 design §9.1) it also keeps the AI's hands off
// two things on disk: config files mp rendered with real values in them, and
// the vault's key. Both are the same kind of rule — it stops the helpful
// "let me just check the file" and the obvious decrypt one-liner, and nothing
// that sets out to get round it.

import process from 'node:process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPayload } from './hook-io.mjs'

const SECRET_RUN = /\bmp(?:\.cmd)?\s+secret\s+run\b/i
const SECRET_CMD = /\bmp(?:\.cmd)?\s+secret\b/i

// ---- files mp answers for ----

function stateDir(env = process.env) {
  return env.MP_STATE_DIR
    || join(env.LOCALAPPDATA || env.HOME || process.cwd(), 'mobile-preview')
}

function readJson(f) {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

// Rendered files of every live slot, plus the ones the user chose to keep.
// Read fresh on every call: they come and go with each `mp secret run`.
export function protectedFiles(env = process.env) {
  const dir = stateDir(env)
  const out = []
  const secrets = join(dir, 'secrets')
  if (existsSync(secrets)) {
    for (const name of readdirSync(secrets)) {
      if (!/^s-[a-z0-9]+\.json$/.test(name)) continue
      for (const f of readJson(join(secrets, name))?.renderedFiles || []) {
        if (typeof f?.path === 'string') out.push(f.path)
      }
    }
  }
  for (const f of readJson(join(dir, 'vault', 'kept-files.json'))?.files || []) {
    if (typeof f?.path === 'string') out.push(f.path)
  }
  return out
}

const WIN = process.platform === 'win32'
const norm = (p) => {
  const r = resolve(p).replaceAll('\\', '/')
  return WIN ? r.toLowerCase() : r
}
const normText = (s) => {
  const r = String(s).replaceAll('\\', '/')
  return WIN ? r.toLowerCase() : r
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const RENDERED_REASON = (p) => `${p} holds real values that mp rendered from a template, so the AI's tools are kept off it. `
  + 'To change the config, edit the template and render again; to check the result, run '
  + '`mp secret peek <file>`, which shows it with every value redacted.'
const VAULT_REASON = 'the vault holds credentials the user saved, encrypted, and decrypting it outside mp is refused. '
  + '`mp secret saved` lists what is saved; `mp secret ask` uses it the way the user allowed.'

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep'])

function decideFile(tool, input, { cwd, files, vaultKey }) {
  const raw = input?.file_path ?? input?.notebook_path ?? input?.path
  if (typeof raw !== 'string' || !raw) return null
  const p = norm(isAbsolute(raw) ? raw : resolve(cwd || process.cwd(), raw))
  if (p === norm(vaultKey)) return { deny: VAULT_REASON }
  const hit = files.find((f) => norm(f) === p)
  return hit ? { deny: `${tool}: ${RENDERED_REASON(hit)}` } : null
}

// Keystore calls aimed at mp's entry, and the key file by name. `mp secret`
// itself never goes through the shell for this, so any command doing it is
// doing it by hand.
const KEYSTORE_READ = /Unprotect|CryptUnprotectData|find-generic-password|secret-tool\s+lookup/i

function decideMention(command, { files, vaultKey }) {
  if (SECRET_CMD.test(command)) return null
  const text = normText(command)
  // `vault.key` alone is not enough: an Ansible project can have a file by
  // that name. Only mp's own, by full path or next to the word mobile-preview.
  if (text.includes(normText(vaultKey))
    || (/mobile-preview/i.test(command) && (text.includes('vault.key') || KEYSTORE_READ.test(command)))) {
    return { deny: VAULT_REASON }
  }
  for (const f of files) {
    const full = norm(f)
    const name = normText(basename(f))
    // The file by full path, or by its name standing alone — `config.yml`
    // but not `config.yml.tpl`, which is the template and fine to read.
    const alone = new RegExp(`(^|[\\s"'=/:(])${escapeRe(name)}($|[\\s"';|&>)])`)
    if (text.includes(full) || alone.test(text)) return { deny: RENDERED_REASON(f) }
  }
  return null
}

// A shell or interpreter given inline code: whatever was approved on the
// phone as an argv, the code inside it is opaque to that approval.
//
// The flag is matched by shape, per family, because none of them spell it one
// way: short flags cluster (`bash -lc`, `node -pe`, `python -Ic`, `perl -ne`),
// long ones take `=` (`node --eval=...`), and PowerShell accepts any prefix of
// a parameter name (`-Co` is `-Command`). Spelling out the common forms is how
// the first version of this list missed all of those.
const powershellCode = (flag) => {
  const p = flag.slice(1).toLowerCase()
  return /^[-/]/.test(flag) && p !== '' && (
    'command'.startsWith(p) || 'encodedcommand'.startsWith(p)
    || 'commandwithargs'.startsWith(p) || p === 'ec' || p === 'cwa')
}
const INLINE = [
  { name: /^(?:sh|bash|zsh|dash|ksh|fish)$/i, code: (f) => /^-[A-Za-z]*c[A-Za-z]*$/.test(f) },
  { name: /^cmd$/i, code: (f) => /^\/[ck]$/i.test(f) },
  { name: /^(?:powershell|pwsh)$/i, code: powershellCode },
  { name: /^(?:node|deno|bun)$/i, code: (f) => /^-[a-z]*[ep][a-z]*$/.test(f) || /^--(?:eval|print)(?:=|$)/.test(f) || f === 'eval' },
  { name: /^(?:python[0-9.]*|py)$/i, code: (f) => /^-[bBdEhiIOPqsSuvVx]*c/.test(f) },
  { name: /^(?:ruby|perl)$/i, code: (f) => /^-[A-Za-z]*[eE]/.test(f) },
  { name: /^php$/i, code: (f) => /^-r/.test(f) },
]

// `C:\Windows\System32\cmd.exe` and `/usr/bin/env` are the programs `cmd`
// and `env`; the rules below compare names, not paths.
const programName = (word) => word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')

// Programs whose whole job is to re-encode what they are given. Redaction
// matches the value and its usual encodings in the daemon's output; piping
// that output through one of these produces an encoding the daemon never saw.
const ENCODER = [
  /^(?:base64|base64\.exe)$/i,
  /^(?:certutil|certutil\.exe)$/i,
  /^(?:xxd|od|hexdump|uuencode|gzip|openssl)(?:\.exe)?$/i,
  /^Format-Hex$/i,
  /^ConvertTo-(?:Base64|SecureString)$/i,
]
const ENCODER_EXPRESSION = /\[(?:System\.)?Convert\]::To(?:Base64String|Hex)/i

// Ways of listing or printing the environment, in the argv itself.
const ENV_DUMP = [
  /^(?:set|env|printenv|export)$/i,
  /^Get-ChildItem$/i, /^gci$/i, /^dir$/i, /^ls$/i, /^env:/i,
  /GetEnvironmentVariable/i,
  /process\.env/i, /os\.environ/i, /getenv\(/i, /ENV\[/i,
  /\$env:/i, /%[A-Za-z_][A-Za-z0-9_]*%/, /\$\{?[A-Z_][A-Z0-9_]+\}?/,
]

// Splits the whole tool command the way the shell would, only far enough to
// find the argv after `--`. Quotes are respected; nothing else is.
function words(command) {
  const out = []
  let cur = null
  let quote = null
  for (const c of String(command)) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur = cur ?? ''
      continue
    }
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur)
      cur = null
      continue
    }
    cur = (cur ?? '') + c
  }
  if (cur !== null) out.push(cur)
  return out
}

// The argv ends at the first unquoted shell operator, because that is where
// the shell ends it too. Reading past it made `mp secret run -- node x.js;
// "$LASTEXITCODE"` look like an argv that expands an environment variable, and
// a hook that denies correct commands teaches the model to route around it.
export function splitPipeline(command) {
  const segments = []
  let text = ''
  let quote = null
  let opBefore = null

  const push = (nextOp) => {
    segments.push({ text, opBefore })
    text = ''
    opBefore = nextOp
  }

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    if (quote) {
      text += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      text += c
      continue
    }
    if (c === '|' || c === '&' || c === ';' || c === '\n') {
      const pair = command.slice(i, i + 2)
      const operator = pair === '&&' || pair === '||' ? pair : c
      push(operator)
      if (operator.length === 2) i += 1
      continue
    }
    text += c
  }
  push(null)
  return segments
}

export function argvAfterSeparator(command) {
  const w = words(command)
  const i = w.indexOf('--')
  return i < 0 ? [] : w.slice(i + 1)
}

export function decide({ tool_name: tool, tool_input: input, cwd } = {}, {
  env = process.env, files = null,
} = {}) {
  const vaultKey = join(stateDir(env), 'vault', 'vault.key')
  if (FILE_TOOLS.has(tool)) {
    return decideFile(tool, input, { cwd, files: files ?? protectedFiles(env), vaultKey })
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return null
  const command = String(input?.command ?? '')
  const mention = decideMention(command, { files: files ?? protectedFiles(env), vaultKey })
  if (mention) return mention
  if (!SECRET_RUN.test(command)) return null

  const segments = splitPipeline(command)
  const at = segments.findIndex((s) => SECRET_RUN.test(s.text))
  if (at < 0) return null

  // Redirecting the redacted output to a file is fine; re-encoding it is not.
  const next = segments[at + 1]
  if (next?.opBefore === '|') {
    const head = words(next.text)[0]?.replace(/^.*[\\/]/, '') ?? ''
    if (ENCODER.some((re) => re.test(head)) || ENCODER_EXPRESSION.test(next.text)) {
      return {
        deny: `mp secret run: piping the output into \`${head || next.text.trim()}\` is refused — `
          + 'it would re-encode values that were redacted on the way out. Read the output as it comes.',
      }
    }
  }

  const argv = argvAfterSeparator(segments[at].text)
  if (!argv.length) return null

  const [head, ...rest] = argv
  const base = programName(head)
  const family = INLINE.find((f) => f.name.test(base))
  if (family && rest.some(family.code)) {
    return {
      deny: `mp secret run: \`${base}\` with inline code is refused — the code inside it is not what the user approved on the phone. `
        + 'Run the script file or the tool directly instead, e.g. `-- node deploy.js`.',
    }
  }

  // The program itself is checked by name, so a path or `.exe` does not hide
  // `printenv`; the arguments are checked as written, so an argument that
  // merely ends in `/ls` is not mistaken for a listing.
  const dump = [base, ...argv].find((a) => ENV_DUMP.some((re) => re.test(a)))
  if (dump) {
    return {
      deny: `mp secret run: \`${dump}\` looks like it prints or expands the environment, which is where the values live. `
        + 'The values are meant to be used by the command, never shown; run the tool that needs them directly.',
    }
  }
  return null
}

async function main() {
  // Bounded, like the other hooks: a host that hands over an inherited
  // terminal instead of closing stdin would leave this pending until the
  // timeout killed it, and the deny — the one control that still holds in
  // bypassPermissions mode — would simply never be printed.
  const payload = await readPayload()
  if (!payload) return
  const verdict = decide(payload)
  if (!verdict) return
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.deny,
    },
  })}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
