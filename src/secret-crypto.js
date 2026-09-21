import {
  createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync,
} from 'node:crypto'

// Quick Tunnel terminates TLS at Cloudflare's edge, so the edge sees whatever
// crosses it in the clear. The form page therefore encrypts every field in
// the browser before it is posted: ECDH on P-256 (the curve phone Safari's
// WebCrypto supports without surprises), HKDF-SHA256 to an AES-256-GCM key,
// the field name as associated data so a ciphertext cannot be moved from one
// field to another. The daemon holds the private half in memory only.
//
// This defeats a passive edge. An active one that rewrote the page's public
// key would still win — as it would against any web form without certificate
// pinning. The design says so (§4.3) rather than claiming otherwise.

export const KDF_INFO = 'mp-secret-v1'

export function generateServerKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  return { privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }
}

function isP256Jwk(jwk) {
  return Boolean(jwk)
    && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && typeof jwk.y === 'string'
}

export function deriveKey(privateKey, clientJwk, salt) {
  if (!isP256Jwk(clientJwk)) throw new Error('client key is not a P-256 public key')
  const saltBuf = Buffer.from(String(salt ?? ''), 'base64')
  if (saltBuf.length < 16) throw new Error('salt is too short')

  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: clientJwk.x, y: clientJwk.y },
    format: 'jwk',
  })
  const shared = diffieHellman({ privateKey, publicKey })
  return Buffer.from(hkdfSync('sha256', shared, saltBuf, KDF_INFO, 32))
}

// WebCrypto's AES-GCM output is ciphertext with the 16-byte tag appended.
export function decryptField(key, name, { iv, ct } = {}) {
  const ivBuf = Buffer.from(String(iv ?? ''), 'base64')
  const data = Buffer.from(String(ct ?? ''), 'base64')
  if (ivBuf.length !== 12 || data.length < 16) throw new Error(`field ${name}: malformed ciphertext`)

  const tag = data.subarray(data.length - 16)
  const body = data.subarray(0, data.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, ivBuf)
  d.setAAD(Buffer.from(name, 'utf8'))
  d.setAuthTag(tag)
  try {
    return Buffer.concat([d.update(body), d.final()]).toString('utf8')
  } catch {
    throw new Error(`field ${name}: authentication failed`)
  }
}

// `expected` is the list of field names the form offered; anything else in
// the submission is refused rather than silently stored. `optional` names may
// be present or not — the vault passphrase travels this way, encrypted like
// any field, and only when the page asked for it.
export function decryptSubmission(privateKey, { clientPub, salt, fields } = {}, expected, { optional = [] } = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('submission has no fields')
  }
  const key = deriveKey(privateKey, clientPub, salt)
  const values = {}
  for (const name of expected) {
    if (!(name in fields)) throw new Error(`field ${name} is missing`)
    values[name] = decryptField(key, name, fields[name])
  }
  for (const name of optional) {
    if (name in fields) values[name] = decryptField(key, name, fields[name])
  }
  for (const name of Object.keys(fields)) {
    if (!expected.includes(name) && !optional.includes(name)) throw new Error(`unexpected field ${name}`)
  }
  return values
}

// The browser side of the same scheme, shipped inline in the form page.
// Written as a string rather than a module so the page stays a single
// response with no second request — see design §4.2 on bandwidth.
export const BROWSER_ENCRYPT_JS = `
async function mpEncrypt(serverJwk, fields) {
  const enc = new TextEncoder()
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  const srv = await crypto.subtle.importKey('jwk', serverJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: srv }, kp.privateKey, 256)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(${JSON.stringify(KDF_INFO)}) },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const out = {}
  for (const [name, value] of Object.entries(fields)) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(name) }, key, enc.encode(value))
    out[name] = { iv: b64(iv), ct: b64(ct) }
  }
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { clientPub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, salt: b64(salt), fields: out }
}
`
