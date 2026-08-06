import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const TUNNEL_URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/i
const TUNNEL_READY_RE = /Registered tunnel connection|Connection registered/i

export function parseTunnelUrl(text) {
  const m = TUNNEL_URL_RE.exec(String(text))
  return m ? m[0] : null
}

export function parseTunnelReady(text) {
  return TUNNEL_READY_RE.test(String(text))
}

export function findCloudflared() {
  try {
    const out = execFileSync('where', ['cloudflared'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const first = out.split(/\r?\n/).find(Boolean)
    return first ? first.trim() : null
  } catch {
    // Continue with common WinGet/MSI locations below.
  }

  const candidates = [
    `${process.env.LOCALAPPDATA || ''}\\Microsoft\\WinGet\\Links\\cloudflared.exe`,
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  ]

  return candidates.find((candidate) => candidate && existsSync(candidate)) || null
}

export function installHint() {
  return [
    'cloudflared not found. Install it with one of:',
    '  winget install --id Cloudflare.cloudflared',
    '  or download from https://github.com/cloudflare/cloudflared/releases',
  ].join('\n')
}

export function killTree(pid) {
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // already dead — treat as success
  }
}

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Writes synchronously: cloudflared is low-volume, and a flushed-on-every-chunk
// log is what makes it useful when the daemon dies mid-handshake.
export function createLogSink(path, { truncate = false } = {}) {
  if (!path) return { write() {} }

  let broken = false
  mkdirSync(dirname(path), { recursive: true })
  if (truncate) {
    try {
      writeFileSync(path, '')
    } catch {
      broken = true
    }
  }

  return {
    write(chunk) {
      if (broken) return
      try {
        appendFileSync(path, chunk)
      } catch {
        // A log we cannot write must never take the tunnel down with it.
        broken = true
      }
    },
  }
}

function attemptTunnel(localPort, { timeoutMs, bin, spawnFn, sink }) {
  return new Promise((resolve, reject) => {
    // --protocol http2 强制走 TCP。cloudflared 默认使用 QUIC/UDP 7844，
    // 该端口在中国大陆网络下干扰明显，隧道会反复重连。
    const child = spawnFn(bin, [
      'tunnel',
      '--no-autoupdate',
      '--protocol', 'http2',
      '--url', `http://127.0.0.1:${localPort}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let settled = false
    let buf = ''

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child.pid)
      reject(new Error(`cloudflared did not establish a tunnel connection within ${timeoutMs}ms`))
    }, timeoutMs)

    const onData = (d) => {
      // Keep mirroring after the tunnel is up — reconnects and edge errors
      // land here too, and that is exactly what we want on disk.
      sink.write(d.toString())
      if (settled) return
      buf += d.toString()
      const url = parseTunnelUrl(buf)
      if (!url || !parseTunnelReady(buf)) return
      settled = true
      clearTimeout(timer)
      resolve({ url, pid: child.pid })
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared exited with code ${code} before producing a url`))
    })
  })
}

export async function startTunnel(localPort, {
  timeoutMs = 30000,
  logPath = null,
  bin = findCloudflared(),
  spawnFn = spawn,
  tries = 4,
  retryDelayMs = 2000,
} = {}) {
  if (!bin) throw new Error(installHint())

  // Truncate once per call, not once per attempt: the failures that led up to
  // the last try are the whole reason the log exists.
  const sink = createLogSink(logPath, { truncate: true })
  const seeLog = logPath ? ` See ${logPath} for cloudflared output.` : ''
  let last = null

  for (let n = 1; n <= tries; n += 1) {
    sink.write(`--- attempt ${n}/${tries} ---\n`)
    try {
      return await attemptTunnel(localPort, { timeoutMs, bin, spawnFn, sink })
    } catch (err) {
      last = err
      if (n < tries) await new Promise((r) => setTimeout(r, retryDelayMs))
    }
  }

  const plural = tries === 1 ? 'attempt' : 'attempts'
  throw new Error(
    `cloudflared failed to establish a tunnel after ${tries} ${plural}: ${last?.message || last}.${seeLog}`,
  )
}
