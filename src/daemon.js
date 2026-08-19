import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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

// Sweeps by directory listing rather than by state.list(). list() skips any
// slot whose JSON will not parse, so sweeping by it left a corrupt slot — and
// the cloudflared it owns — running forever, invisible to every command that
// only ever consults list() (`mp status`) or acts on a single resolved port
// (`mp stop` with exactly one active preview — see Gap 4). Split out from
// cleanupAll so those paths can reach it without also touching every other
// port's live preview, which a full cleanupAll would.
export function sweepCorruptSlots() {
  const dir = state.previewsDir()
  const unreadable = []

  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(name)
      if (!m) continue

      const port = Number(m[1])
      if (state.read(port)) continue // parses fine — not this sweep's job

      rmSync(join(dir, name), { force: true })
      unreadable.push(port)
    }
  }

  return { unreadable }
}

// The unreadable ones cannot have their pids reclaimed, so they are reported
// separately: counting them as a clean stop would be a lie.
export function cleanupAll() {
  const dir = state.previewsDir()
  let killed = 0

  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(name)
      if (!m) continue

      const port = Number(m[1])
      const s = state.read(port)
      if (s) {
        killed += killRecorded(s)
        state.clear(port)
      }
    }
  }

  const { unreadable } = sweepCorruptSlots()
  const legacy = cleanupLegacy()
  return { killed: killed + legacy.killed, legacy: legacy.found, unreadable }
}

// A daemon may only clear the slot it still owns. Two concurrent
// `mp start --port N` (cmdStart reads, then spawns, with nothing in between)
// or a double-spawn over a corrupt file can leave an older daemon alive with
// a newer one holding the slot; the older one's TTL firing would otherwise
// wipe the newer one's record and orphan its tunnel.
export function clearOwnedState(port, pid = process.pid) {
  const s = state.read(port)
  if (!s || s.daemonPid !== pid) return false

  state.clear(port)
  return true
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
  // Mirrors the spawnFn seam startTunnel already has. Without it every path
  // downstream of this call — the state write on success, the daemonPid
  // ownership check in shutdown, the onWindowOpen wire to state.write — was
  // only reachable by actually spawning cloudflared, so it was covered by
  // inspection, not by a test.
  startTunnelFn = startTunnel,
}) {
  mkdirSync(galleryDir, { recursive: true })

  const galleryToken = mintToken()
  const sessionToken = mintToken()
  const expiresAt = Date.now() + ttlMinutes * 60_000

  const graceMs = graceMinutes * 60_000

  const proxy = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt,
    graceMs,
    dev,
    targetPort,
    // Record the moment the window opened so `mp status` can say that the
    // printed link is no longer exchangeable. The proxy knows when it happens
    // but must not know about state.js (spec §5), so it hands the moment over
    // and the daemon — which owns the state file — does the writing.
    onWindowOpen: ({ at }) => {
      try {
        state.write(targetPort, { graceOpenedAt: at })
      } catch {
        // Status detail is not worth failing a request the user is making.
      }
    },
  })

  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = proxy.address().port

  // Claim the slot before the tunnel exists, and deliberately without the
  // tokens: previewHealth still reads this as `incomplete`, so nothing treats
  // it as a usable preview and no link can be printed from it. What it buys is
  // that a second `mp start --port N` can see there is already a daemon here
  // and attach to it instead of spawning a rival into the same slot — the
  // shape behind "the first start printed nothing, the second printed a link".
  state.write(targetPort, {
    daemonPid: process.pid,
    targetPort,
    proxyPort,
    dev,
    expiresAt,
    graceMs,
    galleryDir,
    stage: 'starting',
    stageAt: Date.now(),
  })

  let tunnelPid = null

  // Pure cleanup, split from the process.exit below on purpose: a test can
  // call this directly and observe its effect, whereas nothing survives
  // calling process.exit on the process it is running in.
  const shutdown = () => {
    killTree(tunnelPid)
    proxy.close()
    clearOwnedState(targetPort)
  }

  const exitOnShutdown = () => {
    shutdown()
    process.exit(0)
  }

  const ttlTimer = setTimeout(exitOnShutdown, Math.max(0, expiresAt - Date.now()))
  ttlTimer.unref?.()
  const pollTimer = setInterval(() => {
    if (Date.now() >= expiresAt) exitOnShutdown()
  }, 15_000)
  pollTimer.unref?.()

  process.on('SIGINT', exitOnShutdown)
  process.on('SIGTERM', exitOnShutdown)

  // Undoes the two process.on calls and the two timers above. The daemon
  // process itself never calls this — it lives until exitOnShutdown ends the
  // process — but a test driving runDaemon in-process must, or every test
  // that does leaks another pair of global SIGINT/SIGTERM listeners onto the
  // shared test runner process.
  const dispose = () => {
    clearTimeout(ttlTimer)
    clearInterval(pollTimer)
    process.removeListener('SIGINT', exitOnShutdown)
    process.removeListener('SIGTERM', exitOnShutdown)
  }

  const logPath = state.tunnelLogPath(targetPort)

  try {
    const t = await startTunnelFn(proxyPort, {
      logPath,
      // The CLI cannot see the daemon's stdio (it is spawned detached with
      // stdio: 'ignore'), so the state file is the only channel through which
      // "still working, here is where" can reach a waiting `mp start`.
      onProgress: ({ stage, attempt, tries }) => {
        try {
          state.write(targetPort, {
            stage, attempt, tries, stageAt: Date.now(),
          })
        } catch {
          // Progress is a nicety; losing it must not fail the startup.
        }
      },
    })
    tunnelPid = t.pid
    state.write(targetPort, {
      tunnelUrl: t.url,
      tunnelPid,
      daemonPid: process.pid,
      proxyPort,
      targetPort,
      dev,
      expiresAt,
      graceMs,
      galleryDir,
      galleryToken,
      sessionToken,
      stage: 'ready',
      stageAt: Date.now(),
      artifacts: [],
    })
  } catch (err) {
    dispose()
    proxy.close()
    state.write(targetPort, {
      error: String(err?.message || err),
      errorReason: err?.reason || 'unknown',
      logPath,
      daemonPid: process.pid,
      stage: 'failed',
      stageAt: Date.now(),
    })
    process.exit(1)
  }

  return {
    proxy, proxyPort, targetPort, shutdown, dispose,
  }
}
