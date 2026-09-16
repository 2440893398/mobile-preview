import { readCookie, tokenMatches } from './auth.js'
import { SESSION_TOKEN_QUERY_PARAM } from './proxy.js'

// What the two phone-facing servers — the secret form and the interaction
// page — need identically: the same four replies, and the same front door.
//
// The front door is the part worth sharing. It is the preview proxy's
// authentication with nothing added: a one-time token in the query string is
// exchanged for a cookie inside a grace window, every failure answers 404
// rather than explaining itself, and an IP that keeps failing stops getting
// answers at all. Two copies of that would drift, and the copy that drifted
// would be the one still serving a link to a phone.

export function notFound(res) {
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
  })
  res.end('Not Found')
}

export function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  })
  res.end(JSON.stringify(body))
}

export function clientIp(req) {
  const raw = req.headers['cf-connecting-ip']
  const value = Array.isArray(raw) ? raw[0] : raw
  const ip = typeof value === 'string' ? value.trim() : ''
  return ip || req.socket.remoteAddress || 'unknown'
}

// An oversized body is drained rather than cut off, so the 413 can actually
// be delivered — a socket destroyed mid-upload reads as "network error" on
// the phone, not as "too large". Past a few multiples of the limit the
// connection is dropped anyway: no legitimate submission is that big.
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        if (size > limit * 4) req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) reject(new Error('too large'))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

export function createFailureLimiter({ maxFailures = 10, windowMs = 5 * 60_000 } = {}) {
  const failures = new Map()

  return {
    tripped(ip) {
      const f = failures.get(ip)
      if (!f) return false
      if (Date.now() > f.resetAt) {
        failures.delete(ip)
        return false
      }
      return f.count >= maxFailures
    },
    record(ip) {
      const now = Date.now()
      if (failures.size >= 256) {
        for (const [key, f] of failures) if (now > f.resetAt) failures.delete(key)
      }
      const current = failures.get(ip)
      if (!current || now > current.resetAt) {
        failures.set(ip, { count: 1, resetAt: now + windowMs })
        return
      }
      current.count += 1
    },
  }
}

// Returns a gate the server calls first for every request. `true` means the
// caller may handle it; `false` means a reply has already been sent and the
// handler must do nothing more.
//
// `closed` is the one thing the two servers disagree on: the secret form
// closes for good on its single submission, the interaction page stays open
// until it is answered or its link expires. Both express it the same way.
export function createAccessGate({
  cookie,
  sessionHash,
  expiresAt,
  graceMs = 10 * 60_000,
  closed = () => false,
  maxFailures = 10,
  failureWindowMs = 5 * 60_000,
}) {
  const expiry = Number.isFinite(expiresAt) ? expiresAt : 0
  const grace = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 0
  const limiter = createFailureLimiter({ maxFailures, windowMs: failureWindowMs })
  let graceUntil = null

  return function gate(req, res, url) {
    const ip = clientIp(req)

    if (Date.now() > expiry || closed()) {
      notFound(res)
      return false
    }
    if (limiter.tripped(ip)) {
      notFound(res)
      return false
    }

    const jar = readCookie(req.headers.cookie, cookie)
    const qsToken = url.searchParams.get(SESSION_TOKEN_QUERY_PARAM)

    if (qsToken) {
      if (!tokenMatches(qsToken, sessionHash)) {
        limiter.record(ip)
        notFound(res)
        return false
      }
      const now = Date.now()
      // The window opens on the first successful exchange, not at startup:
      // a link nobody opened for 20 minutes is still good, and one that was
      // opened stops being a credential shortly after.
      if (graceUntil === null) {
        graceUntil = now + grace
      } else if (now >= graceUntil) {
        limiter.record(ip)
        notFound(res)
        return false
      }
      const maxAge = Math.max(0, Math.floor((expiry - now) / 1000))
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `${cookie}=${qsToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
        'X-Robots-Tag': 'noindex, nofollow',
      })
      res.end()
      return false
    }

    if (!tokenMatches(jar, sessionHash)) {
      if (jar) limiter.record(ip)
      notFound(res)
      return false
    }

    return true
  }
}
