import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as state from './state.js'
import { cleanupStale, previewHealth } from './daemon.js'

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
    if (a === '--port' || a === '--ttl' || a === '--steps' || a === '--device') {
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

async function waitForState(predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = state.read()
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

  const existing = state.read()
  const health = previewHealth(existing)
  if (health.active) {
    console.log(formatStart(startView(existing)))
    return
  }

  if (existing) cleanupStale()

  if (!(await portIsOpen(port))) {
    console.error(`nothing is listening on 127.0.0.1:${port}. Start your app first.`)
    process.exit(1)
  }

  const galleryDir = join(process.env.LOCALAPPDATA || process.cwd(), 'mobile-preview', 'gallery')
  const child = spawn(process.execPath, [
    join(HERE, 'daemon-entry.js'),
    String(port),
    String(dev),
    String(ttl),
    galleryDir,
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()

  const s = await waitForState((x) => x.tunnelUrl || x.error)
  if (!s) {
    console.error('timed out waiting for the tunnel')
    process.exit(1)
  }
  if (s.error) {
    console.error(s.error)
    state.clear()
    process.exit(1)
  }

  console.log(formatStart(startView(s)))
}

async function cmdCapture(args) {
  const parsed = parseArgs(args)
  const s = state.read()
  if (!previewHealth(s).active) {
    if (s) cleanupStale()
    console.error('no active preview. Run `mp start` first.')
    process.exit(1)
  }

  const url = parsed.positionals[0] || `http://127.0.0.1:${s.targetPort}/`
  const video = Boolean(parsed.video)
  const steps = await loadSteps(parsed.steps)
  const { capture } = await import('./capture.js')

  const r = await capture({ url, outDir: s.galleryDir, steps, video, deviceName: parsed.device })
  state.write({ artifacts: [...(s.artifacts || []), ...r.shots, r.video].filter(Boolean) })

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
  const s = state.read()
  if (!s) {
    console.log('no active preview')
    return
  }

  if (s.error) {
    console.log(s.error)
    return
  }

  const health = previewHealth(s)
  if (health.reason === 'expired') {
    console.log('previous preview has expired; cleaning up')
    cleanupStale()
    return
  }

  if (!health.active) {
    console.log('previous preview is stale; cleaning up')
    cleanupStale()
    return
  }

  console.log(formatStart(startView(s)))
  console.log(`artifacts: ${(s.artifacts || []).length}`)
}

function cmdStop() {
  const r = cleanupStale()
  console.log(`stopped (${r.killed} process tree(s) terminated)`)
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
