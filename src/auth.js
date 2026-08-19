import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const HASH_RE = /^[0-9a-f]{64}$/i

const ALWAYS_BLOCKED = [
  /\/@fs\//i,
  /(^|\/)\.env/i,
  /(^|\/)\.git(\/|$)/i,
]

const DEV_ONLY = [
  /\/@vite\//i,
  /\/@id\//i,
  /(^|\/)node_modules(\/|$)/i,
  /\.map$/i,
]

function pathVariants(pathname) {
  let current = String(pathname).replaceAll('\\', '/')
  const variants = [current]

  // Push *after* each decode, so the deepest form always makes the list.
  // Pushing before decoding used to drop the final layer: a triple-encoded
  // /@fs/ decoded clean on the last iteration but was never checked.
  for (let i = 0; i < 3; i += 1) {
    let decoded
    try {
      decoded = decodeURIComponent(current).replaceAll('\\', '/')
    } catch {
      return null
    }

    if (decoded === current) break
    current = decoded
    variants.push(current)
  }

  return variants
}

export function mintToken() {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function tokenMatches(given, hash) {
  if (typeof given !== 'string' || !TOKEN_RE.test(given)) return false
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return false

  const expected = Buffer.from(hashToken(given), 'hex')
  const actual = Buffer.from(hash.toLowerCase(), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function parseArtifactPath(pathname) {
  const m = /^\/_a\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(pathname))
  if (!m) return null
  return { token: m[1], file: m[2] }
}

export function isBlockedPath(pathname, { dev = false } = {}) {
  const variants = pathVariants(pathname)
  if (!variants) return true

  if (variants.some((p) => ALWAYS_BLOCKED.some((re) => re.test(p)))) return true
  if (!dev && variants.some((p) => DEV_ONLY.some((re) => re.test(p)))) return true
  return false
}

export function readCookie(header, name) {
  if (!header || !name) return null

  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}
