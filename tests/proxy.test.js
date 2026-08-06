import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProxy } from '../src/proxy.js'
import { mintToken, hashToken } from '../src/auth.js'

const galleryDir = mkdtempSync(join(tmpdir(), 'mp-gallery-'))
writeFileSync(join(galleryDir, 'shot-1.png'), 'PNGDATA')

const galleryToken = mintToken()
const sessionToken = mintToken()

let server
let base

before(async () => {
  server = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev: false,
    targetPort: 1,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  rmSync(galleryDir, { recursive: true, force: true })
})

test('artifact served without any cookie', async () => {
  const res = await fetch(`${base}/_a/${galleryToken}/shot-1.png`, { redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('set-cookie'), null, 'artifact route must not set cookies')
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal(await res.text(), 'PNGDATA')
})

test('artifact with wrong gallery token is 404', async () => {
  const res = await fetch(`${base}/_a/${mintToken()}/shot-1.png`)
  assert.equal(res.status, 404)
})

test('artifact that does not exist on disk is 404', async () => {
  const res = await fetch(`${base}/_a/${galleryToken}/missing.png`)
  assert.equal(res.status, 404)
})

test('app root without token is 404, not 401 or 403', async () => {
  const res = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(res.status, 404)
})

test('app root with wrong token is 404', async () => {
  const res = await fetch(`${base}/?t=${mintToken()}`, { redirect: 'manual' })
  assert.equal(res.status, 404)
})

test('correct token sets an HttpOnly cookie and redirects to the clean path', async () => {
  const res = await fetch(`${base}/?t=${sessionToken}`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/')
  const cookie = res.headers.get('set-cookie')
  assert.match(cookie, /^mp_session=/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Secure/)
})

test('the query token can only be exchanged once', async () => {
  const oneShotToken = mintToken()
  const oneShot = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(oneShotToken),
    expiresAt: Date.now() + 60_000,
    dev: false,
    targetPort: 1,
  })
  await new Promise((r) => oneShot.listen(0, '127.0.0.1', r))
  const b = `http://127.0.0.1:${oneShot.address().port}`

  const first = await fetch(`${b}/?t=${oneShotToken}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${oneShotToken}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 404)
  oneShot.close()
})

test('a valid session cookie reaches the target and surfaces 502 when it is down', async () => {
  const res = await fetch(`${base}/`, {
    headers: { cookie: `mp_session=${sessionToken}` },
    redirect: 'manual',
  })
  assert.equal(res.status, 502)
})

test('blocked paths are 404 even with a valid session', async () => {
  for (const p of ['/@fs/C:/x', '/.env', '/@vite/client']) {
    const res = await fetch(`${base}${p}`, { headers: { cookie: `mp_session=${sessionToken}` } })
    assert.equal(res.status, 404, `${p} must be blocked`)
  }
})

test('an expired session is 404', async () => {
  const expired = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() - 1,
    dev: false,
    targetPort: 1,
  })
  await new Promise((r) => expired.listen(0, '127.0.0.1', r))
  const b = `http://127.0.0.1:${expired.address().port}`
  const res = await fetch(`${b}/`, { headers: { cookie: `mp_session=${sessionToken}` } })
  assert.equal(res.status, 404)
  const art = await fetch(`${b}/_a/${galleryToken}/shot-1.png`)
  assert.equal(art.status, 404, 'expiry must also kill artifact access')
  expired.close()
})

test('repeated bad tokens trip the rate limiter', async () => {
  const rl = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev: false,
    targetPort: 1,
    maxFailures: 3,
  })
  await new Promise((r) => rl.listen(0, '127.0.0.1', r))
  const b = `http://127.0.0.1:${rl.address().port}`
  for (let i = 0; i < 3; i += 1) await fetch(`${b}/?t=${mintToken()}`)
  const res = await fetch(`${b}/?t=${sessionToken}`, { redirect: 'manual' })
  assert.equal(res.status, 404)
  rl.close()
})
