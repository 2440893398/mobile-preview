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

async function proxyWith(overrides) {
  const token = mintToken()
  const server = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(token),
    expiresAt: Date.now() + 60_000,
    dev: false,
    targetPort: 1,
    ...overrides,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, token, base: `http://127.0.0.1:${server.address().port}` }
}

test('宽限窗口内可以重复兑换，预取烧掉的就是第一次', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 60_000 })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 302, '窗口内第二次兑换必须仍然放行')
  assert.match(second.headers.get('set-cookie'), /^mp_session=/)
  server.close()
})

test('宽限窗口关闭后，正确的令牌也是 404', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 20 })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await new Promise((r) => setTimeout(r, 40))
  const late = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(late.status, 404)
  server.close()
})

test('窗口外的兑换计入限流——那正是泄漏重放的形状', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 20, maxFailures: 2 })

  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await new Promise((r) => setTimeout(r, 40))
  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  // 限流已触发，此时连合法 cookie 也一并挡下
  const res = await fetch(`${b}/`, { headers: { cookie: `mp_session=${token}` } })
  assert.equal(res.status, 404)
  server.close()
})

test('grace 为 0 时退回一次性语义', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 0 })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 404)
  server.close()
})

test('窗口从首次兑换开始计时，而非从签发开始', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 60_000 })

  // 静置一段时间后才首次兑换，窗口这时才打开
  await new Promise((r) => setTimeout(r, 60))
  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 302)
  server.close()
})

test('错误令牌在任何时候都是 404，且不打开窗口', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 60_000 })

  const bad = await fetch(`${b}/?t=${mintToken()}`, { redirect: 'manual' })
  const good = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(bad.status, 404)
  assert.equal(good.status, 302, '错误令牌不应消耗掉真令牌的首次兑换')
  server.close()
})

test('TTL 到期优先于宽限窗口', async () => {
  const { server, token, base: b } = await proxyWith({
    graceMs: 60_000,
    expiresAt: Date.now() - 1,
  })

  const res = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  assert.equal(res.status, 404)
  server.close()
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
