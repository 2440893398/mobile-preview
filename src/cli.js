import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as state from './state.js'
import {
  cleanupAll, cleanupLegacy, cleanupStale, previewHealth, sweepCorruptSlots,
} from './daemon.js'
import { establishBudgetMs } from './tunnel.js'

// Covers daemon process startup, the proxy's listen() before it even calls
// startTunnel, and the final state-file write — none of which are part of
// startTunnel's own retry budget but all of which happen before the CLI can
// see a result.
const DAEMON_STARTUP_SLACK_MS = 10_000

const HERE = dirname(fileURLToPath(import.meta.url))

const VALUE_FLAGS = new Set(['--port', '--ttl', '--steps', '--device', '--grace'])

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

function parseArgs(args) {
  const positionals = []
  const out = { positionals }

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--dev' || a === '--video') {
      out[a.slice(2)] = true
      continue
    }
    if (VALUE_FLAGS.has(a)) {
      const v = args[i + 1]
      // A value flag with nothing after it used to record `undefined`, which
      // is indistinguishable from "flag absent" — so `mp stop --port` silently
      // auto-resolved a preview the user never named. Refuse instead: the
      // whole port-resolution design rests on never guessing.
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`)
      out[a.slice(2)] = v
      i += 1
      continue
    }
    if (a.startsWith('--')) {
      out[a.slice(2)] = true
      continue
    }
    positionals.push(a)
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

  lines.push('')
  if (consoleErrors.length === 0 && failedRequests.length === 0) {
    lines.push('Page loaded clean: no console errors, no failed requests.')
  } else {
    if (consoleErrors.length) {
      lines.push(`CONSOLE ERRORS (${consoleErrors.length}):`)
      for (const e of consoleErrors) lines.push(`  - ${e}`)
    }
    if (failedRequests.length) {
      lines.push(`FAILED REQUESTS (${failedRequests.length}):`)
      for (const f of failedRequests) lines.push(`  - ${f.status ?? f.error} ${f.url}`)
    }
  }
  return lines.join('\n')
}

export function formatStart({ tunnelUrl, sessionToken, expiresAt, dev }) {
  const mins = Math.round((expiresAt - Date.now()) / 60_000)
  const lines = [
    `preview: ${tunnelUrl}/?t=${sessionToken}`,
    `expires in ${mins} min`,
  ]
  if (dev) {
    lines.push('dev mode: dev server exposed. HMR is not guaranteed over the tunnel.')
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

  return previews.map((s) => {
    const mins = Math.round((s.expiresAt - now) / 60_000)
    // The url goes on its own bare line: mobile chat clients render code
    // blocks unselectable, and a link the user cannot copy is a link that
    // never arrives. See skill/SKILL.md.
    const lines = [
      `port ${s.targetPort}:`,
      `${s.tunnelUrl}/?t=${s.sessionToken}`,
      `  expires in ${mins} min, artifacts: ${(s.artifacts || []).length}`,
    ]
    if (windowClosed(s, now)) {
      lines.push(
        '  link no longer exchangeable — the phone\'s existing session still'
        + ' works; run mp stop && mp start for a fresh link',
      )
    }
    return lines.join('\n')
  }).join('\n\n')
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

// The CLI's wait for the tunnel, derived from startTunnel's own retry budget
// plus slack rather than a constant of its own — see DAEMON_STARTUP_SLACK_MS.
export function tunnelWaitBudgetMs() {
  return establishBudgetMs() + DAEMON_STARTUP_SLACK_MS
}

// `stopped` lets the caller cut the wait short. The budget is 136s — right
// for the retry case, far too long to sit silent when the daemon died in its
// first second and its stdio went to /dev/null. A daemon writes its state
// file synchronously before exiting, so an exit observed at the top of an
// iteration is always preceded by a poll that could already see the result.
async function waitForState(port, predicate, {
  timeoutMs = tunnelWaitBudgetMs(),
  stopped = () => false,
} = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = state.read(port)
    if (s && predicate(s)) return s
    if (stopped()) return null
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 300))
  }
}

function sweepLegacy() {
  const legacy = cleanupLegacy()
  if (legacy.found) {
    console.log(`cleaned up a legacy single-slot state file (${legacy.killed} process tree(s) terminated)`)
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
    console.log(
      `warning: removed ${unreadable.length} unreadable state file(s) `
      + `(port(s) ${unreadable.join(', ')}); any cloudflared they owned may still be running`,
    )
  }
}

function reportSweep(r) {
  console.log(`stopped (${r.killed} process tree(s) terminated)`)
  if (r.unreadable?.length) {
    // Their recorded pids were unreadable, so whatever they owned could not be
    // killed. Saying "stopped" and nothing else would be a lie.
    console.log(
      `warning: removed ${r.unreadable.length} unreadable state file(s) `
      + `(port(s) ${r.unreadable.join(', ')}); any cloudflared they owned may still be running`,
    )
  }
}

async function cmdStart(args) {
  const parsed = parseArgs(args)
  const port = numericFlag(parsed, 'port', 5173, { integer: true, min: 1, max: 65535 })
  const dev = Boolean(parsed.dev)
  // Upper bound is 1440 minutes (24h), not the 35791min ceiling setTimeout's
  // 2^31-1 ms limit would technically allow. A preview is for showing a
  // running app to a phone during a work session, not something to leave
  // exposed for weeks; a day is generous slack for that and still comfortably
  // clears the timer overflow that made the daemon die in 1ms.
  const ttl = numericFlag(parsed, 'ttl', 30, { integer: true, min: 1, max: 1440 })
  // 0 is valid and means one-shot (see proxy.js) — min is 0, not 1.
  const grace = numericFlag(parsed, 'grace', 10, { integer: true, min: 0 })

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
    console.error(
      `preview state for port ${port} is corrupt: ${f} could not be parsed as JSON. `
      + 'Its recorded pids could not be read, so any process it referenced cannot be '
      + 'reclaimed automatically. Run `mp stop --all` (sweeps corrupt slots) or delete the file.',
    )
    process.exit(1)
  }

  const existing = existingState.value
  if (previewHealth(existing).active) {
    console.log(formatStart(startView(existing)))
    return
  }

  if (existing) cleanupStale(port)

  if (!(await portIsOpen(port))) {
    console.error(`nothing is listening on 127.0.0.1:${port}. Start your app first.`)
    process.exit(1)
  }

  const galleryDir = state.galleryDir(port)
  const child = spawn(process.execPath, [
    join(HERE, 'daemon-entry.js'),
    JSON.stringify({ targetPort: port, dev, ttlMinutes: ttl, graceMinutes: grace, galleryDir }),
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()

  // unref() does not suppress the exit event, and stdio: 'ignore' means the
  // daemon's own error message goes nowhere — so its exit code is the only
  // signal we get that it died before writing anything.
  let exitCode = null
  child.once('exit', (code) => { exitCode = code ?? -1 })

  const s = await waitForState(port, (x) => x.tunnelUrl || x.error, {
    stopped: () => exitCode !== null,
  })
  if (!s) {
    console.error(exitCode !== null
      ? `the preview daemon exited (code ${exitCode}) before the tunnel came up`
      : 'timed out waiting for the tunnel')
    process.exit(1)
  }
  if (s.error) {
    console.error(s.error)
    state.clear(port)
    process.exit(1)
  }

  console.log(formatStart(startView(s)))
}

async function cmdCapture(args) {
  const parsed = parseArgs(args)
  const port = resolvePort(parsed)
  if (port === null) {
    console.error('no active preview. Run `mp start` first.')
    process.exit(1)
  }

  const s = state.read(port)
  if (!previewHealth(s).active) {
    if (s) cleanupStale(port)
    console.error('no active preview. Run `mp start` first.')
    process.exit(1)
  }

  const url = parsed.positionals[0] || `http://127.0.0.1:${s.targetPort}/`
  const video = Boolean(parsed.video)
  const steps = await loadSteps(parsed.steps)
  const { capture } = await import('./capture.js')

  const r = await capture({ url, outDir: s.galleryDir, steps, video, deviceName: parsed.device })
  state.write(port, { artifacts: [...(s.artifacts || []), ...r.shots, r.video].filter(Boolean) })

  console.log(formatCapture({
    tunnelUrl: s.tunnelUrl,
    galleryToken: s.galleryToken,
    shots: r.shots,
    video: r.video,
    consoleErrors: r.consoleErrors,
    failedRequests: r.failedRequests,
  }))
}

function cmdStatus() {
  sweepLegacy()
  sweepCorrupt()

  const all = state.list()
  const live = []

  for (const s of all) {
    if (s.error) {
      console.log(`port ${s.targetPort}: ${s.error}`)
      continue
    }

    const health = previewHealth(s)
    if (health.active) {
      live.push(s)
      continue
    }

    const why = health.reason === 'expired' ? 'has expired' : 'is stale'
    console.log(`port ${s.targetPort}: previous preview ${why}; cleaning up`)
    cleanupStale(s.targetPort)
  }

  console.log(formatStatus(live))
}

function cmdStop(args) {
  const parsed = parseArgs(args)

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
    return
  }

  const r = cleanupStale(port)
  console.log(`stopped port ${port} (${r.killed} process tree(s) terminated)`)
}

export async function main(argv) {
  const [cmd, ...rest] = argv
  const table = {
    start: cmdStart,
    capture: cmdCapture,
    status: cmdStatus,
    stop: cmdStop,
  }
  const fn = table[cmd]
  if (!fn) {
    console.error('usage: mp <start|capture|status|stop>')
    process.exit(1)
  }
  await fn(rest)
}
