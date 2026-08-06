import { mkdirSync } from 'node:fs'
import { createProxy } from './proxy.js'
import { hashToken, mintToken } from './auth.js'
import { isAlive, killTree, startTunnel } from './tunnel.js'
import * as state from './state.js'

export function cleanupStale() {
  const s = state.read()
  if (!s) return { killed: 0 }

  const pids = [...new Set([s.tunnelPid, s.daemonPid].filter(Boolean))]
  let killed = 0

  for (const pid of pids) {
    if (!isAlive(pid)) continue
    killTree(pid)
    killed += 1
  }

  state.clear()
  return { killed }
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

export async function runDaemon({ targetPort, dev = false, ttlMinutes = 30, galleryDir }) {
  mkdirSync(galleryDir, { recursive: true })

  const galleryToken = mintToken()
  const sessionToken = mintToken()
  const expiresAt = Date.now() + ttlMinutes * 60_000

  const proxy = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt,
    dev,
    targetPort,
  })

  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = proxy.address().port

  let tunnelPid = null

  const shutdown = () => {
    killTree(tunnelPid)
    proxy.close()
    state.clear()
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
    const t = await startTunnel(proxyPort, { logPath: state.tunnelLogPath() })
    tunnelPid = t.pid
    state.write({
      tunnelUrl: t.url,
      tunnelPid,
      daemonPid: process.pid,
      proxyPort,
      targetPort,
      dev,
      expiresAt,
      galleryDir,
      galleryToken,
      sessionToken,
      artifacts: [],
    })
  } catch (err) {
    proxy.close()
    state.write({
      error: String(err?.message || err),
      daemonPid: process.pid,
    })
    process.exit(1)
  }
}
