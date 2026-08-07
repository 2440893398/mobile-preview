import { createServer, request as httpRequest } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hashToken, isBlockedPath, parseArtifactPath, readCookie, tokenMatches } from './auth.js'

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.html': 'text/html; charset=utf-8',
}

function mimeFor(file) {
  const dot = file.lastIndexOf('.')
  return MIME[file.slice(dot).toLowerCase()] || 'application/octet-stream'
}

function notFound(res) {
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
  })
  res.end('Not Found')
}

function stripSessionCookie(header) {
  if (!header) return undefined

  const kept = String(header)
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.split('=')[0] !== 'mp_session')

  return kept.length ? kept.join('; ') : undefined
}

function forward(req, res, { targetPort }) {
  const headers = { ...req.headers }
  headers.host = `localhost:${targetPort}`

  const cookie = stripSessionCookie(req.headers.cookie)
  if (cookie) headers.cookie = cookie
  else delete headers.cookie

  delete headers['accept-encoding']

  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      const responseHeaders = { ...up.headers, 'X-Robots-Tag': 'noindex, nofollow' }
      res.writeHead(up.statusCode || 502, responseHeaders)

      if (req.method === 'HEAD') {
        up.resume()
        res.end()
        return
      }

      up.pipe(res)
    },
  )

  upstream.on('error', () => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(502, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
    })
    res.end('Bad Gateway')
  })

  req.on('aborted', () => upstream.destroy())
  req.pipe(upstream)
}

// Behind cloudflared every connection arrives from 127.0.0.1, so keying the
// limiter on the socket address buckets every remote visitor into one counter:
// ten prefetches by a chat client would lock out the legitimate cookie-holder.
// The proxy binds 127.0.0.1 only, so the sole route in is through cloudflared,
// and Cloudflare's edge sets CF-Connecting-IP itself (a client-supplied value
// is overwritten there, so it cannot be forged from the outside).
function clientIp(req) {
  const raw = req.headers['cf-connecting-ip']
  const value = Array.isArray(raw) ? raw[0] : raw
  const ip = typeof value === 'string' ? value.trim() : ''
  return ip || req.socket.remoteAddress || 'unknown'
}

export function createProxy({
  galleryDir,
  galleryToken,
  sessionHash,
  expiresAt,
  dev = false,
  targetPort,
  graceMs = 10 * 60_000,
  maxFailures = 10,
  failureWindowMs = 5 * 60_000,
  onWindowOpen = null,
}) {
  const galleryHash = hashToken(galleryToken)
  const failures = new Map()
  // Fail closed. A non-finite expiresAt (a `--ttl abc` typo that made it
  // through) would make `Date.now() > expiresAt` permanently false — the TTL
  // check would never fire — and `Math.max(0, expiresAt - Date.now())` below
  // would produce `Max-Age=NaN`, which browsers discard per RFC 6265, silently
  // turning the session cookie into a browser-session cookie. Degrade to 0,
  // i.e. already expired, so everything 404s instead. The CLI validates too,
  // but createProxy has a second caller and this failure mode is silent.
  const expiry = Number.isFinite(expiresAt) ? expiresAt : 0
  // Fail closed. A non-finite graceMs (a `--grace 10m` typo that made it
  // through) would set graceUntil to NaN, and nothing is ever >= NaN — the
  // window would never close and the URL would be a permanent credential.
  // Degrade to one-shot instead, never to "never closes". The CLI validates
  // too, but createProxy has a second caller and this failure mode is silent.
  const grace = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 0
  // Opened by the first successful exchange, not by minting. Link prefetch in
  // a chat client burns the first exchange before the human ever taps; the
  // window is what lets the human still get in. Once it closes only the
  // cookie works, so a URL that leaks later is already dead.
  let graceUntil = null

  function tripped(ip) {
    const f = failures.get(ip)
    if (!f) return false
    if (Date.now() > f.resetAt) {
      failures.delete(ip)
      return false
    }
    return f.count >= maxFailures
  }

  function recordFailure(ip) {
    const now = Date.now()
    const current = failures.get(ip)
    if (!current || now > current.resetAt) {
      failures.set(ip, { count: 1, resetAt: now + failureWindowMs })
      return
    }
    current.count += 1
  }

  return createServer((req, res) => {
    const ip = clientIp(req)
    const url = new URL(req.url || '/', 'http://localhost')
    const pathname = url.pathname

    if (Date.now() > expiry) return notFound(res)
    if (tripped(ip)) return notFound(res)

    const artifact = parseArtifactPath(pathname)
    if (artifact) {
      if (!tokenMatches(artifact.token, galleryHash)) {
        recordFailure(ip)
        return notFound(res)
      }

      const file = join(galleryDir, artifact.file)
      if (!existsSync(file) || !statSync(file).isFile()) return notFound(res)

      res.writeHead(200, {
        'Content-Type': mimeFor(artifact.file),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      })

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      createReadStream(file).pipe(res)
      return
    }

    if (isBlockedPath(pathname, { dev })) return notFound(res)

    const qsToken = url.searchParams.get('t')
    if (qsToken) {
      if (!tokenMatches(qsToken, sessionHash)) {
        recordFailure(ip)
        return notFound(res)
      }

      const now = Date.now()
      if (graceUntil === null) {
        // Written once, on the first exchange only: the window must not slide.
        // An implementation that re-armed here would keep the whole suite
        // green while making the window unbounded for any client that polls
        // the link — see the non-sliding test in tests/proxy.test.js.
        graceUntil = now + grace
        // Bookkeeping only. The callback exists so the daemon can record the
        // moment in the state file without proxy.js ever importing state.js
        // (spec §5 module boundaries); it must never take a request down.
        try {
          onWindowOpen?.({ at: now, until: graceUntil })
        } catch {
          // ignored on purpose
        }
      } else if (now >= graceUntil) {
        // A correct token arriving after the window is the shape of a replayed
        // leak, so it counts against the limiter.
        recordFailure(ip)
        return notFound(res)
      }

      url.searchParams.delete('t')
      const clean = pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '')
      const maxAge = Math.max(0, Math.floor((expiry - Date.now()) / 1000))
      res.writeHead(302, {
        Location: clean,
        'Set-Cookie': `mp_session=${qsToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
        'X-Robots-Tag': 'noindex, nofollow',
      })
      res.end()
      return
    }

    const cookie = readCookie(req.headers.cookie, 'mp_session')
    if (!tokenMatches(cookie, sessionHash)) {
      if (cookie) recordFailure(ip)
      return notFound(res)
    }

    forward(req, res, { targetPort })
  })
}
