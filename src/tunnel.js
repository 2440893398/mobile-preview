import { spawn, execFileSync } from 'node:child_process'

const TUNNEL_URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/i

export function parseTunnelUrl(text) {
  const m = TUNNEL_URL_RE.exec(String(text))
  return m ? m[0] : null
}

export function findCloudflared() {
  try {
    const out = execFileSync('where', ['cloudflared'], { encoding: 'utf8' })
    const first = out.split(/\r?\n/).find(Boolean)
    return first ? first.trim() : null
  } catch {
    return null
  }
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

export function startTunnel(localPort, { timeoutMs = 30000 } = {}) {
  const bin = findCloudflared()
  if (!bin) return Promise.reject(new Error(installHint()))

  return new Promise((resolve, reject) => {
    // --protocol http2 强制走 TCP。cloudflared 默认使用 QUIC/UDP 7844，
    // 该端口在中国大陆网络下干扰明显，隧道会反复重连。
    const child = spawn(bin, [
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
      reject(new Error(`cloudflared did not report a tunnel url within ${timeoutMs}ms`))
    }, timeoutMs)

    const onData = (d) => {
      if (settled) return
      buf += d.toString()
      const url = parseTunnelUrl(buf)
      if (!url) return
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
