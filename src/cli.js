import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as state from './state.js'
import {
  cleanupAll, cleanupLegacy, cleanupStale, previewHealth, sweepCorruptSlots,
} from './daemon.js'
import {
  establishBudgetMs, isAlive, reapOrphanTunnels, stageText,
} from './tunnel.js'
import { SESSION_TOKEN_QUERY_PARAM } from './proxy.js'
import {
  COMMANDS, GROUPS, VERSION, renderCommandHelp, renderGroupHelp, renderHelp,
} from './usage.js'
import { LOCALHOST_HARDCODE_HINT, formatDoctor, runChecks } from './doctor.js'
import { resolveServeTarget } from './static.js'
import { createSecretCommands } from './secret-cli.js'
import { createInteractionCommands } from './interaction-cli.js'
import { readMark, writeMark } from '../plugins/mobile-preview/hooks/session-mark.mjs'

// Covers daemon process startup, the proxy's listen() before it even calls
// startTunnel, and the final state-file write — none of which are part of
// startTunnel's own retry budget but all of which happen before the CLI can
// see a result.
const DAEMON_STARTUP_SLACK_MS = 10_000

const HERE = dirname(fileURLToPath(import.meta.url))

// stdout belongs to the machine-readable payload when --json is on. Every
// human-facing line moves to stderr then, so a caller can pipe stdout straight
// into a parser without filtering prose out of it first.
let jsonMode = false

function note(msg) {
  if (jsonMode) console.error(msg)
  else console.log(msg)
}

function emitJson(payload) {
  console.log(JSON.stringify(payload, null, 2))
}

function fail(msg, extra = null) {
  if (jsonMode) emitJson({ status: 'error', error: msg, ...extra })
  console.error(msg)
  process.exit(1)
}

// Rejects anything the command does not declare. A `--devv` typo used to be
// swallowed as a truthy boolean nobody read, so the command ran with the
// opposite of what was asked for and said nothing about it.
function parseArgs(args, commandName) {
  const spec = COMMANDS[commandName]
  const flags = spec.flags
  const positionals = []
  const out = { positionals }

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]

    if (a === '--help' || a === '-h') {
      out.help = true
      continue
    }

    // Everything after `--` belongs to the command being run, `--help` and
    // all; it is handed over untouched and never parsed as ours.
    if (a === '--') {
      if (!spec.rest) fail(`\`mp ${commandName}\` does not take a -- separator. Run \`mp ${commandName} --help\`.`)
      out.rest = args.slice(i + 1)
      break
    }

    if (!a.startsWith('--')) {
      positionals.push(a)
      continue
    }

    const eq = a.indexOf('=')
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
    const inline = eq === -1 ? null : a.slice(eq + 1)
    const def = flags[name]

    if (!def) {
      const known = Object.keys(flags).map((f) => `--${f}`).join(', ')
      fail(`unknown option --${name} for \`mp ${commandName}\`. It accepts: ${known || '(no options)'}. `
        + `Run \`mp ${commandName} --help\`.`)
    }

    if (!def.value) {
      if (inline !== null) fail(`--${name} is a switch and takes no value, got --${name}=${inline}`)
      out[name] = true
      continue
    }

    const v = inline !== null ? inline : args[i + 1]
    // A value flag with nothing after it used to record `undefined`, which
    // is indistinguishable from "flag absent" — so `mp stop --port` silently
    // auto-resolved a preview the user never named. Refuse instead: the
    // whole port-resolution design rests on never guessing.
    if (v === undefined || (inline === null && v.startsWith('--'))) fail(`--${name} needs a value`)
    if (def.repeat) (out[name] ||= []).push(v)
    else out[name] = v
    if (inline === null) i += 1
  }

  const max = spec.maxPositionals ?? 0
  if (positionals.length > max) {
    fail(`unexpected argument ${JSON.stringify(positionals[max])} for \`mp ${commandName}\`. `
      + `Run \`mp ${commandName} --help\`.`)
  }

  return out
}

// Every numeric flag goes through here. A typo that becomes NaN is silent and
// dangerous downstream: `--grace 10m` makes graceUntil NaN, and since nothing
// is ever >= NaN the grace window never closes — the session URL becomes a
// permanent credential. `--ttl abc` makes the setTimeout fire in 1ms and the
// daemon dies instantly. Reject at the boundary, name the flag and the value.
//
// Finiteness alone is not enough: `--port 99999` is finite but not a port,
// and `mp stop --port 99999` would print "stopped port 99999" having found
// and touched nothing — a quieter echo of the same fail-open shape. `--ttl
// 40000` (minutes) is finite but overflows setTimeout's 2^31-1 ms limit,
// which Node silently clamps to a 1ms timer, killing the daemon instantly.
// integer/min/max let each call site say what "valid" means for that flag.
function numericFlag(parsed, name, fallback, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const raw = parsed[name]
  if (raw === undefined) return fallback

  const text = String(raw).trim()
  const n = Number(text)
  if (text === '' || !Number.isFinite(n)) {
    fail(`--${name} must be a number, got ${JSON.stringify(String(raw))}`)
  }
  if (integer && !Number.isInteger(n)) {
    fail(`--${name} must be an integer, got ${JSON.stringify(String(raw))}`)
  }
  if (n < min || n > max) {
    const bound = min === -Infinity
      ? `at most ${max}`
      : max === Infinity
        ? `at least ${min}`
        : `between ${min} and ${max}`
    fail(`--${name} must be ${bound}, got ${JSON.stringify(String(raw))}`)
  }
  return n
}

async function loadSteps(stepPath) {
  if (!stepPath) return null
  const abs = resolve(stepPath)
  const mod = await import(pathToFileURL(abs).href)
  const fn = mod.default ?? mod.steps ?? mod.run
  if (typeof fn !== 'function') {
    throw new Error(`steps file ${stepPath} does not export a function`)
  }
  return fn
}

// The link handed to the phone. `__mp_token` rather than the older `t`: Vite
// uses `?t=<timestamp>` for its own module cache-busting, so a bare `t` put the
// preview's auth parameter and the dev server's own query in the same
// namespace — which is how a dev-mode preview ended up rendering a blank page.
// The proxy still accepts `?t=` so links already in someone's chat history
// keep working.
export function previewUrl({ tunnelUrl, sessionToken }) {
  return `${tunnelUrl}/?${SESSION_TOKEN_QUERY_PARAM}=${sessionToken}`
}

function formatConsoleError(e) {
  if (typeof e === 'string') return e
  const where = e.url ? ` (${e.url}${e.line ? `:${e.line}` : ''})` : ''
  return `${e.text}${where}`
}

function formatFailedRequest(f) {
  const type = f.resourceType ? ` [${f.resourceType}]` : ''
  return `  - ${f.status ?? f.error}${type} ${f.url}`
}

export function formatCapture({
  tunnelUrl,
  galleryToken,
  shots = [],
  video = null,
  consoleErrors = [],
  failedRequests = [],
}) {
  const lines = []
  const base = `${tunnelUrl}/_a/${galleryToken}`

  for (const s of shots) {
    const alt = s.replace(/\.[^.]+$/, '')
    lines.push(`![${alt}](${base}/${s})`)
  }
  if (video) lines.push(`[${video}](${base}/${video})`)

  // Split by severity rather than lumping everything together: a missing
  // favicon and a missing entry script both print "404" and only one of them
  // explains a blank page.
  const errors = failedRequests.filter((f) => f.severity !== 'warning')
  const warnings = failedRequests.filter((f) => f.severity === 'warning')

  lines.push('')
  if (consoleErrors.length === 0 && errors.length === 0) {
    lines.push('Page loaded clean: no console errors, no failed requests.')
  } else {
    if (consoleErrors.length) {
      lines.push(`CONSOLE ERRORS (${consoleErrors.length}):`)
      for (const e of consoleErrors) lines.push(`  - ${formatConsoleError(e)}`)
    }
    if (errors.length) {
      lines.push(`FAILED REQUESTS (${errors.length}):`)
      for (const f of errors) lines.push(formatFailedRequest(f))
    }
  }

  if (warnings.length) {
    lines.push(`IGNORABLE (${warnings.length}) — favicons, source maps and the like:`)
    for (const f of warnings) lines.push(formatFailedRequest(f))
  }

  return lines.join('\n')
}

export function formatStart({
  tunnelUrl, sessionToken, expiresAt, dev, serve = null, port = null,
}) {
  const mins = Math.round((expiresAt - Date.now()) / 60_000)
  const lines = [
    `preview: ${previewUrl({ tunnelUrl, sessionToken })}`,
    `expires in ${mins} min`,
    // The daemon and its tunnel are windowless (see tunnel.js), so nothing on
    // the desktop says a preview is running and nothing can be closed to end
    // one. Say both here, once, rather than leave the user hunting in Task
    // Manager for something they can no longer see.
    'running in the background, no window — `mp status` to check on it,'
    + ' `mp stop` to end it early',
  ]
  if (serve) {
    // Named because the agent that ran this did not choose the port and has no
    // other way to learn it — and because "mp is serving this" is the fact that
    // makes a second, hand-started server unnecessary.
    lines.push(`serving ${serve} on 127.0.0.1:${port} — mp's own server, it stops with the preview`)
  }
  if (dev) {
    lines.push('dev mode: dev server exposed. WebSockets are not proxied, so Vite HMR '
      + 'does not work through the preview — reload the page to pick up changes.')
  }
  return lines.join('\n')
}

// True once the grace window that opened on the first exchange has closed:
// the link still prints, but tapping it now returns the deliberately
// uninformative 404. graceOpenedAt is recorded by the daemon (see
// createProxy's onWindowOpen); a preview nobody has tapped yet has none.
function windowClosed(s, now) {
  if (!s.graceOpenedAt) return false
  const grace = Number.isFinite(s.graceMs) ? s.graceMs : 0
  return now >= s.graceOpenedAt + grace
}

export function formatStatus(previews, now = Date.now()) {
  if (previews.length === 0) return 'no active preview'

  const blocks = previews.map((s) => {
    const mins = Math.round((s.expiresAt - now) / 60_000)
    // The url goes on its own bare line: mobile chat clients render code
    // blocks unselectable, and a link the user cannot copy is a link that
    // never arrives. See skill/SKILL.md.
    const lines = [
      s.serve ? `port ${s.targetPort} (mp serving ${s.serve}):` : `port ${s.targetPort}:`,
      previewUrl(s),
      `  expires in ${mins} min, artifacts: ${(s.artifacts || []).length}`,
    ]
    // A preview owns no window of its own (see the windowsHide comment in
    // tunnel.js), so this listing is the only place it is visible at all.
    // Naming the pids and the log is what makes that a fair trade: it is what
    // the window used to be good for.
    if (s.daemonPid && s.tunnelPid) {
      lines.push(`  daemon pid ${s.daemonPid}, cloudflared pid ${s.tunnelPid}`)
      lines.push(`  log: ${state.tunnelLogPath(s.targetPort)}`)
    }
    if (windowClosed(s, now)) {
      lines.push(
        '  link no longer exchangeable — the phone\'s existing session still'
        + ' works; run mp stop && mp start for a fresh link',
      )
    }
    return lines.join('\n')
  })

  blocks.push('previews run in the background with no window: `mp stop [--port N]`'
    + ' ends one, `mp stop --all` ends every one.')
  return blocks.join('\n\n')
}

function startPayload(s, port) {
  return {
    status: 'ready',
    url: previewUrl(s),
    tunnelUrl: s.tunnelUrl,
    sessionToken: s.sessionToken,
    galleryToken: s.galleryToken,
    port,
    expiresAt: s.expiresAt,
    expiresInMinutes: Math.round((s.expiresAt - Date.now()) / 60_000),
    dev: Boolean(s.dev),
    serve: s.serve ?? null,
  }
}

function activePreviews() {
  return state.list().filter((s) => previewHealth(s).active)
}

// Returns the port to act on, or null when there is none. Never guesses
// between several: on a phone the user cannot see the machine's state, and
// stopping the wrong service costs more than typing --port.
function resolvePort(parsed) {
  if (parsed.port !== undefined) {
    return numericFlag(parsed, 'port', null, { integer: true, min: 1, max: 65535 })
  }

  const active = activePreviews()
  if (active.length === 1) return active[0].targetPort
  if (active.length === 0) return null

  const ports = active.map((s) => s.targetPort).join(', ')
  console.error(`several previews are active (ports ${ports}). Pass --port to pick one.`)
  process.exit(1)
}

function startView(s) {
  return {
    tunnelUrl: s.tunnelUrl,
    sessionToken: s.sessionToken,
    expiresAt: s.expiresAt,
    dev: s.dev,
    serve: s.serve ?? null,
    port: s.targetPort,
  }
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    const done = (ok) => {
      sock.destroy()
      resolve(ok)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(1500, () => done(false))
  })
}

// --serve picks its own port rather than asking for one: the whole reason the
// flag exists is that a port chosen by hand is a port something else may
// already be sitting on, serving a page from an hour ago. The kernel's choice
// is free by definition. The gap between closing this listener and the daemon
// binding the same number is a few milliseconds wide; if something takes it in
// between, the daemon says so rather than proxying whatever landed there.
function freePort() {
  return new Promise((ok, no) => {
    const probe = createServer()
    probe.once('error', no)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    })
  })
}

// The CLI's wait for the tunnel, derived from startTunnel's own retry budget
// plus slack rather than a constant of its own — see DAEMON_STARTUP_SLACK_MS.
export function tunnelWaitBudgetMs() {
  return establishBudgetMs() + DAEMON_STARTUP_SLACK_MS
}

function stageLine(s) {
  if (!s?.stage) return null
  const attempt = s.attempt && s.tries ? ` (attempt ${s.attempt}/${s.tries})` : ''
  return `... ${stageText(s.stage)}${attempt}`
}

// Waits for the daemon to reach a terminal outcome, narrating the stages it
// passes through on the way. The narration is the point: the daemon is spawned
// detached with stdio pointed at nowhere, so before it recorded its stage the
// only thing a user saw during a slow establishment was a silent prompt for up
// to 136 seconds — indistinguishable from a hang, and the reason `mp start`
// got a reputation for "sometimes printing nothing".
//
// `stopped` lets the caller cut the wait short. A daemon writes its state file
// synchronously before exiting, so an exit observed at the top of an iteration
// is always preceded by a poll that could already see the result; the state is
// re-read once more on the way out to close the remaining sliver.
async function awaitTunnel(port, { stopped = () => false, timeoutMs = tunnelWaitBudgetMs() } = {}) {
  const deadline = Date.now() + timeoutMs
  let announced = null
  let latest = null

  for (;;) {
    const s = state.read(port)
    if (s) {
      latest = s
      if (s.tunnelUrl || s.error) return { state: s, outcome: s.error ? 'error' : 'ready' }

      const key = `${s.stage}:${s.attempt ?? ''}`
      if (s.stage && key !== announced) {
        announced = key
        const line = stageLine(s)
        if (line) note(line)
      }
    }

    if (stopped()) return { state: state.read(port) || latest, outcome: 'stopped' }
    if (Date.now() >= deadline) return { state: latest, outcome: 'timeout' }
    await new Promise((r) => setTimeout(r, 300))
  }
}

// "timed out waiting for the tunnel" on its own was the whole message, and it
// left the user with no way to tell a network that will never work from one
// that needed another twenty seconds — with a daemon still running behind it
// either way. Name the stage it reached, whether anything is still trying, and
// where to read the rest.
export function formatStartTimeout({
  port, latest, budgetMs, logPath, daemonAlive,
}) {
  const attempt = latest?.attempt ? ` (attempt ${latest.attempt}/${latest.tries})` : ''
  return [
    `timed out after ${Math.round(budgetMs / 1000)}s waiting for the tunnel on port ${port}.`,
    `last stage: ${stageText(latest?.stage)}${attempt}`,
    daemonAlive
      ? `the daemon (pid ${latest.daemonPid}) is still running — run \`mp status\` shortly to see if it `
        + `got there, or \`mp stop --port ${port}\` to give up on it.`
      : `no daemon is running for port ${port} any more — run \`mp start --port ${port}\` again.`,
    `cloudflared output: ${logPath}`,
  ].join('\n')
}

function failTimeout(port, latest) {
  const alive = Boolean(latest?.daemonPid && isAlive(latest.daemonPid))
  const logPath = state.tunnelLogPath(port)

  fail(formatStartTimeout({
    port, latest, budgetMs: tunnelWaitBudgetMs(), logPath, daemonAlive: alive,
  }), {
    status: alive ? 'starting' : 'error',
    port,
    stage: latest?.stage ?? null,
    daemonPid: alive ? latest.daemonPid : null,
    logPath,
  })
}

function sweepLegacy() {
  const legacy = cleanupLegacy()
  if (legacy.found) {
    note(`cleaned up a legacy single-slot state file (${legacy.killed} process tree(s) terminated)`)
  }
}

// Corrupt slots are invisible to state.list() (it skips anything that won't
// parse), so any path that doesn't go through cleanupAll — status's listing,
// stop's single-resolved-port branch — walks straight past one and leaves
// whatever cloudflared it names running forever (Gap 4). Reported the same
// way reportSweep reports cleanupAll's unreadable ones: a silently deleted
// record whose process could not be reclaimed must not read as nothing
// happened.
function sweepCorrupt() {
  const { unreadable } = sweepCorruptSlots()
  if (unreadable.length) {
    note(
      `warning: removed ${unreadable.length} unreadable state file(s) `
      + `(port(s) ${unreadable.join(', ')}); any cloudflared they owned may still be running`,
    )
  }
}

// Runs after the state-file sweeps, never before: those kill and clear the
// slots they can account for, so whatever cloudflared is still standing here
// genuinely has no record left. Recorded tunnels are passed in as `known` so
// the fast path can stop at a single tasklist.
function reapOrphans() {
  const known = new Set(state.list().map((s) => s.tunnelPid).filter(Boolean))
  const pids = reapOrphanTunnels({ known })
  if (pids.length) {
    note(
      `reaped ${pids.length} orphaned cloudflared tunnel(s) (pid ${pids.join(', ')}) — `
      + 'their daemon was gone, so nothing was left to expire them',
    )
  }
}

function reportSweep(r) {
  note(`stopped (${r.killed} process tree(s) terminated)`)
  if (r.unreadable?.length) {
    // Their recorded pids were unreadable, so whatever they owned could not be
    // killed. Saying "stopped" and nothing else would be a lie.
    note(
      `warning: removed ${r.unreadable.length} unreadable state file(s) `
      + `(port(s) ${r.unreadable.join(', ')}); any cloudflared they owned may still be running`,
    )
  }
}

function reportReady(s, port) {
  if (jsonMode) {
    emitJson(startPayload(s, port))
    return
  }
  console.log(formatStart(startView(s)))
}

// A record that belongs to a daemon which is up but has not got a tunnel yet.
// Deliberately not `active`: it carries no tokens, so nothing can print a link
// from it — but it does carry a live daemonPid, which is what lets a second
// `mp start` attach instead of spawning a rival into the same slot.
function isEstablishing(s) {
  return Boolean(s && !s.error && !s.tunnelUrl && s.daemonPid && isAlive(s.daemonPid))
}

async function settleStart(port, { stopped, onStopped }) {
  const { state: s, outcome } = await awaitTunnel(port, { stopped })

  if (outcome === 'ready') {
    reportReady(s, port)
    return
  }
  if (outcome === 'error') {
    const detail = { port, reason: s.errorReason, logPath: s.logPath ?? state.tunnelLogPath(port) }
    state.clear(port)
    fail(s.error, detail)
  }
  if (outcome === 'stopped') {
    onStopped(s)
    return
  }
  failTimeout(port, s)
}

async function cmdStart(args) {
  const parsed = parseArgs(args, 'start')
  if (parsed.help) return console.log(renderCommandHelp('start'))

  const dev = Boolean(parsed.dev)

  // Both flags answer "what is on the other end of the tunnel", so only one of
  // them may: --port points at an app the user started, --serve makes mp the
  // app. Silently letting --port win would put the tunnel on whatever happens
  // to be listening there — the exact confusion --serve exists to end.
  let serve = null
  if (parsed.serve !== undefined) {
    if (parsed.port !== undefined) {
      fail('--serve and --port cannot be combined: with --serve, mp starts the server itself '
        + 'and picks a free port. Drop --port, or drop --serve and start the app yourself.')
    }
    if (dev) {
      fail('--serve and --dev cannot be combined: --dev exposes a dev server, --serve serves '
        + 'static files. Point --port at the dev server instead.')
    }
    try {
      serve = resolveServeTarget(parsed.serve)
    } catch (err) {
      fail(String(err?.message || err))
    }
  }

  const port = serve
    ? await freePort()
    : numericFlag(parsed, 'port', 5173, { integer: true, min: 1, max: 65535 })
  // Upper bound is 1440 minutes (24h), not the 35791min ceiling setTimeout's
  // 2^31-1 ms limit would technically allow. A preview is for showing a
  // running app to a phone during a work session, not something to leave
  // exposed for weeks; a day is generous slack for that and still comfortably
  // clears the timer overflow that made the daemon die in 1ms.
  const ttl = numericFlag(parsed, 'ttl', 30, { integer: true, min: 1, max: 1440 })
  // 0 is valid and means one-shot (see proxy.js) — min is 0, not 1.
  // The default is the full --ttl, not a shorter window: the window opens on
  // the first exchange, so ttl minutes from then always covers the rest of the
  // preview's life — the printed link stays reusable until the preview itself
  // expires. A 10-minute default used to 404 the same link on a second visit,
  // which read as "the preview broke", not as security.
  const grace = numericFlag(parsed, 'grace', ttl, { integer: true, min: 0 })

  sweepLegacy()

  const existingState = state.readState(port)
  if (existingState.status === 'corrupt') {
    // read() alone can't tell "no preview here" from "a preview here whose
    // JSON won't parse" — both come back null. Treating them the same is
    // what let this branch skip cleanupStale and spawn a second daemon into
    // a slot that may already have one, sharing one state file between them
    // from then on. The file often still has tunnelPid/daemonPid in it
    // (they're the 2nd and 3rd keys write() puts down) — just not parseably
    // — so say they could not be parsed, not that they are gone.
    const f = state.statePath(port)
    fail(
      `preview state for port ${port} is corrupt: ${f} could not be parsed as JSON. `
      + 'Its recorded pids could not be read, so any process it referenced cannot be '
      + 'reclaimed automatically. Run `mp stop --all` (sweeps corrupt slots) or delete the file.',
      { port },
    )
  }

  const existing = existingState.value
  if (previewHealth(existing).active) {
    // The establishing branch below says this out loud; the active branch
    // used to swallow the flags silently — `mp start --ttl 120` against an
    // already-running preview printed the old link and nothing else.
    if (parsed.ttl !== undefined || parsed.grace !== undefined || parsed.dev) {
      note(`a preview for port ${port} is already active; its original --ttl/--grace/--dev `
        + 'stay in effect. `mp stop` first to change them.')
    }
    reportReady(existing, port)
    return
  }

  if (isEstablishing(existing)) {
    const daemonPid = existing.daemonPid
    note(`a preview daemon for port ${port} is already starting (pid ${daemonPid}); waiting for it`)
    note('its --ttl/--grace/--dev are the ones it was started with; `mp stop` first to change them')
    await settleStart(port, {
      stopped: () => !isAlive(daemonPid),
      onStopped: (s) => {
        if (s?.error) fail(s.error, { port, reason: s.errorReason, logPath: s.logPath })
        fail(`the preview daemon for port ${port} exited before the tunnel came up. `
          + `See ${state.tunnelLogPath(port)}.`, { port })
      },
    })
    return
  }

  if (existing) cleanupStale(port)

  // With --serve there is deliberately nothing listening yet: the daemon binds
  // this port itself, a few milliseconds from now.
  if (!serve && !(await portIsOpen(port))) {
    fail(`nothing is listening on 127.0.0.1:${port}. Start your app first.`, { port })
  }

  const galleryDir = state.galleryDir(port)
  const child = spawn(process.execPath, [
    join(HERE, 'daemon-entry.js'),
    JSON.stringify({
      targetPort: port, serve, dev, ttlMinutes: ttl, graceMinutes: grace, galleryDir,
    }),
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()

  // unref() does not suppress the exit event, and stdio: 'ignore' means the
  // daemon's own error message goes nowhere — so its exit code is the only
  // signal we get that it died before writing anything.
  let exitCode = null
  child.once('exit', (code) => { exitCode = code ?? -1 })

  await settleStart(port, {
    stopped: () => exitCode !== null,
    onStopped: (s) => {
      if (s?.error) {
        const detail = { port, reason: s.errorReason, logPath: s.logPath ?? state.tunnelLogPath(port) }
        state.clear(port)
        fail(s.error, detail)
      }
      fail(`the preview daemon exited (code ${exitCode}) before the tunnel came up`, { port })
    },
  })
}

async function cmdCapture(args) {
  const parsed = parseArgs(args, 'capture')
  if (parsed.help) return console.log(renderCommandHelp('capture'))

  const port = resolvePort(parsed)
  if (port === null) {
    fail('no active preview. Run `mp start` first.')
  }

  const s = state.read(port)
  if (!previewHealth(s).active) {
    if (s) cleanupStale(port)
    fail('no active preview. Run `mp start` first.')
  }

  const url = parsed.positionals[0] || `http://127.0.0.1:${s.targetPort}/`
  const video = Boolean(parsed.video)
  const steps = await loadSteps(parsed.steps)
  const waitMs = numericFlag(parsed, 'wait-ms', 500, { integer: true, min: 0, max: 600_000 })
  const { capture, knownDevice } = await import('./capture.js')

  // An unrecognised --device used to fall back to the iPhone 13 without a
  // word, so a capture taken "on a Pixel 7" was quietly an iPhone one.
  if (parsed.device !== undefined && !knownDevice(parsed.device)) {
    fail(`unknown --device ${JSON.stringify(parsed.device)}. `
      + 'Use a Playwright device profile name, e.g. "iPhone 13", "Pixel 7", "Galaxy S9+".')
  }

  const r = await capture({
    url,
    outDir: s.galleryDir,
    steps,
    video,
    deviceName: parsed.device,
    waitFor: parsed['wait-for'] ?? null,
    waitMs,
    networkIdle: Boolean(parsed['network-idle']),
    fullPage: Boolean(parsed['full-page']),
  })
  // Functional patch: the append is computed inside the state lock from a
  // fresh read, not from the `s` snapshot taken before the capture ran —
  // two concurrent captures would otherwise each write a list missing the
  // other's artifacts.
  state.write(port, (cur) => ({
    artifacts: [...(cur.artifacts || []), ...r.shots, r.video].filter(Boolean),
  }))

  console.log(formatCapture({
    tunnelUrl: s.tunnelUrl,
    galleryToken: s.galleryToken,
    shots: r.shots,
    video: r.video,
    consoleErrors: r.consoleErrors,
    failedRequests: r.failedRequests,
  }))

  if (parsed.strict) {
    const errors = r.failedRequests.filter((f) => f.severity !== 'warning')
    if (errors.length || r.consoleErrors.length) {
      console.error(
        `--strict: ${errors.length} failed request(s) and ${r.consoleErrors.length} console error(s) on ${url}`,
      )
      process.exit(1)
    }
  }
}

function statusView(s) {
  return {
    port: s.targetPort,
    url: previewUrl(s),
    tunnelUrl: s.tunnelUrl,
    expiresAt: s.expiresAt,
    expiresInMinutes: Math.round((s.expiresAt - Date.now()) / 60_000),
    dev: Boolean(s.dev),
    serve: s.serve ?? null,
    artifacts: s.artifacts || [],
    exchangeable: !windowClosed(s, Date.now()),
    // Same reason as the pid line in formatStatus: with no window to point at,
    // a caller driving this over --json needs the pids and the log from here
    // or from nowhere.
    daemonPid: s.daemonPid ?? null,
    tunnelPid: s.tunnelPid ?? null,
    logPath: state.tunnelLogPath(s.targetPort),
  }
}

function cmdStatus(args) {
  const parsed = parseArgs(args, 'status')
  if (parsed.help) return console.log(renderCommandHelp('status'))

  sweepLegacy()
  sweepCorrupt()

  const all = state.list()
  const live = []

  for (const s of all) {
    if (s.error) {
      note(`port ${s.targetPort}: ${s.error}`)
      continue
    }

    const health = previewHealth(s)
    if (health.active) {
      live.push(s)
      continue
    }

    // A daemon that is still establishing its tunnel is neither active nor
    // stale: sweeping it here would kill the very startup the user is waiting
    // on after `mp start` timed out and told them to check back.
    if (isEstablishing(s)) {
      note(`port ${s.targetPort}: still starting — ${stageText(s.stage)}`
        + `${s.attempt ? ` (attempt ${s.attempt}/${s.tries})` : ''}`)
      continue
    }

    const why = health.reason === 'expired' ? 'has expired' : 'is stale'
    note(`port ${s.targetPort}: previous preview ${why}; cleaning up`)
    cleanupStale(s.targetPort)
  }

  reapOrphans()

  if (parsed.json) {
    emitJson(live.map(statusView))
    return
  }

  console.log(formatStatus(live))
}

function cmdStop(args) {
  const parsed = parseArgs(args, 'stop')
  if (parsed.help) return console.log(renderCommandHelp('stop'))

  // Unconditionally, not just on --all or the no-preview branch: spec §8 says
  // stop handles a leftover pre-multi-slot state.json, and the case that
  // actually reaches a user — one active preview, so resolvePort finds a port
  // and cleanupAll is never called — used to print "stopped" while the legacy
  // daemon kept serving. Cheap when there is nothing to do (one existsSync).
  sweepLegacy()
  // Same reasoning, same escape hatch, for a corrupt slot on a *different*
  // port: the one-active-preview branch below only ever calls
  // cleanupStale(port) for the port it resolved, so without this a corrupt
  // file elsewhere survives every `mp stop` that happens to resolve cleanly
  // (Gap 4).
  sweepCorrupt()

  if (parsed.all) {
    reportSweep(cleanupAll())
    reapOrphans()
    return
  }

  const port = resolvePort(parsed)
  if (port === null) {
    // resolvePort only counts *active* previews (both pids alive, not
    // expired). A dead daemon with a still-running cloudflared, or an
    // expired-but-still-running preview, is stale, not active — so it lands
    // here too. `stop` with no active preview must still mean "make sure
    // nothing is running", so sweep every stale per-port slot as well as the
    // legacy file, not just the legacy file. On an empty state dir this is
    // still {killed: 0}, so the exit-0-on-empty contract is unchanged.
    reportSweep(cleanupAll())
    reapOrphans()
    return
  }

  const r = cleanupStale(port)
  note(`stopped port ${port} (${r.killed} process tree(s) terminated)`)
  // Also here, not just in the two sweep-everything branches: with exactly one
  // active preview `mp stop` resolves a port and lands in this one, which is
  // the shape of the command most people actually type.
  reapOrphans()
}

function cmdDoctor(args) {
  const parsed = parseArgs(args, 'doctor')
  if (parsed.help) return console.log(renderCommandHelp('doctor'))

  const checks = runChecks()

  if (parsed.json) emitJson(checks)
  else console.log(`${formatDoctor(checks)}\n\n${LOCALHOST_HARDCODE_HINT}`)

  if (checks.some((c) => !c.ok && !c.optional)) process.exit(1)
}

function cmdRemote(args, command) {
  const parsed = parseArgs(args, `remote ${command}`)
  if (parsed.help) return console.log(renderCommandHelp(`remote ${command}`))

  const sessionId = parsed.session || process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID
  if (!sessionId) fail('No Codex session ID. Run this inside the Codex session or pass --session <id>.')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId) || sessionId.includes('..')) {
    fail('Invalid session ID.')
  }

  if (command === 'status') {
    const manual = readMark(sessionId)?.manualRemote
    note(manual === true ? 'remote confirmed' : manual === false ? 'local confirmed' : 'not confirmed')
    return
  }

  const manualRemote = command === 'on'
  if (!writeMark(sessionId, { manualRemote, awaitingManualRemote: false })) fail('Could not save this session choice.')
  note(manualRemote ? 'remote confirmed for this session' : 'local confirmed for this session')
}

export async function main(argv) {
  const [cmd, ...rest] = argv

  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(renderHelp())
    return
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(VERSION)
    return
  }

  if (GROUPS[cmd]) {
    const [sub, ...subArgs] = rest
    if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
      console.log(renderGroupHelp(cmd))
      return
    }
    const name = `${cmd} ${sub}`
    const fn = groupCommands[cmd][sub]
    if (!COMMANDS[name] || !fn) {
      console.error(`unknown command ${JSON.stringify(name)}.\n`)
      console.error(renderGroupHelp(cmd))
      process.exit(1)
    }
    jsonMode = subArgs.includes('--json') && Boolean(COMMANDS[name].flags.json)
    await fn(subArgs)
    return
  }

  const table = {
    start: cmdStart,
    capture: cmdCapture,
    status: cmdStatus,
    stop: cmdStop,
    doctor: cmdDoctor,
  }
  const fn = table[cmd]
  if (!fn) {
    console.error(`unknown command ${JSON.stringify(cmd)}.\n`)
    console.error(renderHelp())
    process.exit(1)
  }

  // Set before dispatch so a parse failure in a --json invocation still emits
  // a parseable object rather than only prose on stderr.
  jsonMode = rest.includes('--json') && Boolean(COMMANDS[cmd].flags.json)

  await fn(rest)
}

// Both groups get the same seams — the CLI's own output, argument parsing and
// tunnel budget — so neither can drift into a second way of reporting a
// failure or a second idea of how long a tunnel may take.
const groupDeps = {
  note, emitJson, fail, parseArgs, numericFlag, here: HERE, tunnelWaitBudgetMs,
}
const groupCommands = {
  remote: {
    on: (args) => cmdRemote(args, 'on'),
    off: (args) => cmdRemote(args, 'off'),
    status: (args) => cmdRemote(args, 'status'),
  },
  secret: createSecretCommands(groupDeps),
  interaction: createInteractionCommands(groupDeps),
}
