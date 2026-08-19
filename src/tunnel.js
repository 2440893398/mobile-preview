import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { WIN, findCloudflared } from './locate.js'

export { findCloudflared }

const TUNNEL_URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/i
const TUNNEL_READY_RE = /Registered tunnel connection|Connection registered/i

export function parseTunnelUrl(text) {
  const m = TUNNEL_URL_RE.exec(String(text))
  return m ? m[0] : null
}

export function parseTunnelReady(text) {
  return TUNNEL_READY_RE.test(String(text))
}

// The stages a single attempt moves through. A quick tunnel prints its url
// *before* it has registered anything with Cloudflare's edge, so "url issued"
// and "reachable from a phone" are two different moments — conflating them is
// what produced links that resolved to 530 on the phone. The daemon records
// these in the state file and `mp start` reports them, so a slow establishment
// reads as progress rather than as a hang.
export const TUNNEL_STAGES = {
  CONNECTING: 'connecting',
  REGISTERING: 'registering',
  READY: 'ready',
  RETRYING: 'retrying',
}

export const STAGE_TEXT = {
  starting: 'starting the preview daemon',
  connecting: 'asking trycloudflare.com for a quick tunnel',
  registering: 'tunnel url issued, waiting for an edge connection',
  retrying: 'the last attempt failed, retrying',
  ready: 'tunnel registered with the Cloudflare edge',
}

export function stageText(stage) {
  return STAGE_TEXT[stage] || stage || 'starting up'
}

// What actually went wrong, in the user's terms, read off cloudflared's own
// output. "cloudflared failed after 4 attempts" is true and useless; the three
// failures below want three different actions from the user, and on a
// restricted network (see README, mainland China) the second is overwhelmingly
// the common one.
export function classifyTunnelFailure(log) {
  const text = String(log || '')
  const sawUrl = Boolean(parseTunnelUrl(text))

  if (/failed to connect to origin|dial tcp 127\.0\.0\.1.*(refused|timeout)|connection refused.*127\.0\.0\.1/i.test(text)) {
    return {
      reason: 'origin-unreachable',
      message: 'cloudflared could not reach the local port it was pointed at',
      hint: 'Your app stopped listening, or it binds an interface other than 127.0.0.1. Restart it and check with `mp doctor`.',
    }
  }

  if (/api\.trycloudflare\.com|failed to request quick Tunnel|Unable to reach the origin service/i.test(text)
    && /context deadline exceeded|no such host|i\/o timeout|connection reset|TLS handshake|EOF|timeout/i.test(text)) {
    return {
      reason: 'api-unreachable',
      message: 'could not reach api.trycloudflare.com to request a tunnel',
      hint: 'Outbound DNS or HTTPS to Cloudflare is being blocked or throttled. Retry, or run through a proxy that covers cloudflared (see README, "Running from mainland China").',
    }
  }

  if (sawUrl && !parseTunnelReady(text)) {
    return {
      reason: 'edge-unregistered',
      message: 'cloudflared was issued a tunnel url but never registered an edge connection',
      hint: 'The url exists but nothing can reach it yet — this is the failure that produces 530 on the phone. Outbound to Cloudflare\'s edge is blocked or throttled; retry or use a proxy.',
    }
  }

  return {
    reason: 'unknown',
    message: 'cloudflared did not establish a tunnel',
    hint: 'Read the cloudflared log named above — the last attempt\'s output is the whole story.',
  }
}

export function installHint() {
  return [
    'cloudflared not found. Install it with one of:',
    '  winget install --id Cloudflare.cloudflared',
    '  or download from https://github.com/cloudflare/cloudflared/releases',
  ].join('\n')
}

// On Windows, taskkill /T takes the whole tree. On POSIX there is no
// equivalent one-shot, but every process this project needs dead is recorded
// by pid (daemonPid, tunnelPid) and killed individually, so SIGKILL on the
// one pid suffices. The old unconditional taskkill was a fail-open on
// macOS/Linux: the spawn error was caught as "already dead", `mp stop`
// printed "stopped", and cloudflared kept serving until its TTL.
export function killTree(pid) {
  if (!pid) return
  try {
    if (WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
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

function attemptTunnel(localPort, {
  timeoutMs, bin, spawnFn, sink, onProgress, attempt, tries,
}) {
  const report = (stage, extra = {}) => {
    try {
      onProgress?.({ stage, attempt, tries, ...extra })
    } catch {
      // Progress reporting writes to the state file; a failure there must
      // never take down the tunnel it is reporting on.
    }
  }

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
    let sawUrl = false

    report(TUNNEL_STAGES.CONNECTING)

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
      if (url && !sawUrl) {
        // The url alone is not readiness — say so out loud, because the gap
        // between these two lines is exactly where a restricted network stalls.
        sawUrl = true
        report(TUNNEL_STAGES.REGISTERING, { url })
      }
      if (!url || !parseTunnelReady(buf)) return
      settled = true
      clearTimeout(timer)
      report(TUNNEL_STAGES.READY, { url })
      resolve({ url, pid: child.pid })
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child.pid)
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

export const TUNNEL_DEFAULTS = { timeoutMs: 30_000, tries: 4, retryDelayMs: 2_000 }

// Worst case wall-clock for startTunnel to exhaust its retries. The CLI waits
// on this rather than a constant of its own: two numbers that must agree will
// eventually disagree.
export function establishBudgetMs(opts = {}) {
  const { timeoutMs, tries, retryDelayMs } = { ...TUNNEL_DEFAULTS, ...opts }
  return tries * timeoutMs + Math.max(0, tries - 1) * retryDelayMs
}

// How much cloudflared output to keep in memory for classifyTunnelFailure.
// The log on disk is the record; this is only the tail the diagnosis reads.
const CLASSIFY_TAIL_BYTES = 64 * 1024

export async function startTunnel(localPort, {
  timeoutMs = TUNNEL_DEFAULTS.timeoutMs,
  logPath = null,
  bin = findCloudflared(),
  spawnFn = spawn,
  tries = TUNNEL_DEFAULTS.tries,
  retryDelayMs = TUNNEL_DEFAULTS.retryDelayMs,
  onProgress = null,
} = {}) {
  if (!bin) throw new Error(installHint())

  // Truncate once per call, not once per attempt: the failures that led up to
  // the last try are the whole reason the log exists.
  const fileSink = createLogSink(logPath, { truncate: true })
  let tail = ''
  const sink = {
    write(chunk) {
      fileSink.write(chunk)
      tail = (tail + chunk).slice(-CLASSIFY_TAIL_BYTES)
    },
  }
  const seeLog = logPath ? ` See ${logPath} for cloudflared output.` : ''
  let last = null

  for (let n = 1; n <= tries; n += 1) {
    sink.write(`--- attempt ${n}/${tries} ---\n`)
    try {
      return await attemptTunnel(localPort, {
        timeoutMs, bin, spawnFn, sink, onProgress, attempt: n, tries,
      })
    } catch (err) {
      last = err
      if (n < tries) {
        try {
          onProgress?.({
            stage: TUNNEL_STAGES.RETRYING, attempt: n, tries, error: String(err?.message || err),
          })
        } catch {
          // as above: never let progress reporting break the retry loop
        }
        await new Promise((r) => setTimeout(r, retryDelayMs))
      }
    }
  }

  const plural = tries === 1 ? 'attempt' : 'attempts'
  // The diagnosis goes in the message, not just in the log: on a phone the
  // user often cannot open the log at all, and "failed after 4 attempts" does
  // not tell them whether to restart their app, retry, or turn a proxy on.
  const why = classifyTunnelFailure(tail)
  const err = new Error(
    `cloudflared failed to establish a tunnel after ${tries} ${plural}: ${last?.message || last}.`
    + ` ${why.message}. ${why.hint}${seeLog}`,
  )
  err.reason = why.reason
  err.logPath = logPath
  throw err
}
