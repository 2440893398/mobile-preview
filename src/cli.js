import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as state from './state.js'
import { cleanupAll, cleanupLegacy, cleanupStale, previewHealth } from './daemon.js'
import { establishBudgetMs } from './tunnel.js'

// Covers daemon process startup, the proxy's listen() before it even calls
// startTunnel, and the final state-file write — none of which are part of
// startTunnel's own retry budget but all of which happen before the CLI can
// see a result.
const DAEMON_STARTUP_SLACK_MS = 10_000

const HERE = dirname(fileURLToPath(import.meta.url))

function argOf(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
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
    if (a === '--port' || a === '--ttl' || a === '--steps' || a === '--device' || a === '--grace') {
      out[a.slice(2)] = args[++i]
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

export function formatStatus(previews) {
  if (previews.length === 0) return 'no active preview'

  return previews.map((s) => {
    const mins = Math.round((s.expiresAt - Date.now()) / 60_000)
    // The url goes on its own bare line: mobile chat clients render code
    // blocks unselectable, and a link the user cannot copy is a link that
    // never arrives. See skill/SKILL.md.
    return [
      `port ${s.targetPort}:`,
      `${s.tunnelUrl}/?t=${s.sessionToken}`,
      `  expires in ${mins} min, artifacts: ${(s.artifacts || []).length}`,
    ].join('\n')
  }).join('\n\n')
}

function activePreviews() {
  return state.list().filter((s) => previewHealth(s).active)
}

// Returns the port to act on, or null when there is none. Never guesses
// between several: on a phone the user cannot see the machine's state, and
// stopping the wrong service costs more than typing --port.
function resolvePort(parsed) {
  if (parsed.port !== undefined) return Number(parsed.port)

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

async function waitForState(port, predicate, timeoutMs = tunnelWaitBudgetMs()) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = state.read(port)
    if (s && predicate(s)) return s
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

async function cmdStart(args) {
  const parsed = parseArgs(args)
  const port = Number(parsed.port ?? 5173)
  const dev = Boolean(parsed.dev)
  const ttl = Number(parsed.ttl ?? 30)
  const grace = Number(parsed.grace ?? 10)

  const existing = state.read(port)
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

  const s = await waitForState(port, (x) => x.tunnelUrl || x.error)
  if (!s) {
    console.error('timed out waiting for the tunnel')
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
  const legacy = cleanupLegacy()
  if (legacy.found) {
    console.log(`cleaned up a legacy single-slot state file (${legacy.killed} process tree(s) terminated)`)
  }

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

  if (parsed.all) {
    const r = cleanupAll()
    console.log(`stopped (${r.killed} process tree(s) terminated)`)
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
    const r = cleanupAll()
    console.log(`stopped (${r.killed} process tree(s) terminated)`)
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
