import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createProxy } from './proxy.js'
import { hashToken, mintToken } from './auth.js'
import { isAlive, killTree, startTunnel } from './tunnel.js'
import * as state from './state.js'

function killRecorded(s) {
  if (!s) return 0
  const pids = [...new Set([s.tunnelPid, s.daemonPid].filter(Boolean))]
  let killed = 0

  for (const pid of pids) {
    if (!isAlive(pid)) continue
    killTree(pid)
    killed += 1
  }

  return killed
}

export function cleanupStale(port) {
  const s = state.read(port)
  if (!s) return { killed: 0 }

  const killed = killRecorded(s)
  state.clear(port)
  return { killed }
}

// Pre-multi-slot versions wrote a single state.json. Its processes outlive the
// upgrade, so find them, kill them, and drop the file. No field migration:
// reviving an old preview is worthless, not orphaning its tunnel is not.
export function cleanupLegacy() {
  const f = state.legacyStatePath()
  if (!existsSync(f)) return { killed: 0, found: false }

  let s = null
  try {
    s = JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    s = null
  }

  const killed = killRecorded(s)
  rmSync(f, { force: true })
  return { killed, found: true }
}

export function cleanupAll() {
  let killed = 0
  for (const p of state.list()) killed += cleanupStale(p.targetPort).killed

  const legacy = cleanupLegacy()
  return { killed: killed + legacy.killed, legacy: legacy.found }
}

export function previewHealth(s, now = Date.now()) {
  if (!s) return { active: false, reason: 'missing' }
  if (s.error) return { active: false, reason: 'error' }
  if (!s.tunnelUrl || !s.sessionToken || !s.expiresAt) {
    return { active: false, reason: 'incomplete' }
  }
  if (now > s.expiresAt) return { active: false, reason: 'expired' }

  const requiredPids = [s.daemonPid, s.tunnelPid]
  if (requiredPids.some((pid) => !pid)) {
    return { active: false, reason: 'stale', deadPids: requiredPids.filter((pid) => !pid) }
  }

  const deadPids = [...new Set(requiredPids)].filter((pid) => !isAlive(pid))
  if (deadPids.length) return { active: false, reason: 'stale', deadPids }

  return { active: true, reason: 'active' }
}

export async function runDaemon({
  targetPort,
  dev = false,
  ttlMinutes = 30,
  graceMinutes = 10,
  galleryDir,
}) {
  mkdirSync(galleryDir, { recursive: true })

  const galleryToken = mintToken()
  const sessionToken = mintToken()
  const expiresAt = Date.now() + ttlMinutes * 60_000

  const proxy = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt,
    graceMs: graceMinutes * 60_000,
    dev,
    targetPort,
  })

  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = proxy.address().port

  let tunnelPid = null

  const shutdown = () => {
    killTree(tunnelPid)
    proxy.close()
    state.clear(targetPort)
    process.exit(0)
  }

  const ttlTimer = setTimeout(shutdown, Math.max(0, expiresAt - Date.now()))
  ttlTimer.unref?.()
  const pollTimer = setInterval(() => {
    if (Date.now() >= expiresAt) shutdown()
  }, 15_000)
  pollTimer.unref?.()

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    const t = await startTunnel(proxyPort, { logPath: state.tunnelLogPath(targetPort) })
    tunnelPid = t.pid
    state.write(targetPort, {
      tunnelUrl: t.url,
      tunnelPid,
      daemonPid: process.pid,
      proxyPort,
      targetPort,
      dev,
      expiresAt,
      graceMs: graceMinutes * 60_000,
      galleryDir,
      galleryToken,
      sessionToken,
      artifacts: [],
    })
  } catch (err) {
    proxy.close()
    state.write(targetPort, {
      error: String(err?.message || err),
      daemonPid: process.pid,
    })
    process.exit(1)
  }
}
