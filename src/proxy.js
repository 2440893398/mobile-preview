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

export function createProxy({
  galleryDir,
  galleryToken,
  sessionHash,
  expiresAt,
  dev = false,
  targetPort,
  maxFailures = 10,
  failureWindowMs = 5 * 60_000,
}) {
  const galleryHash = hashToken(galleryToken)
  const failures = new Map()
  let sessionTokenExchanged = false

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
    const ip = req.socket.remoteAddress || 'unknown'
    const url = new URL(req.url || '/', 'http://localhost')
    const pathname = url.pathname

    if (Date.now() > expiresAt) return notFound(res)
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
      if (sessionTokenExchanged || !tokenMatches(qsToken, sessionHash)) {
        recordFailure(ip)
        return notFound(res)
      }

      sessionTokenExchanged = true
      url.searchParams.delete('t')
      const clean = pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '')
      const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
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
