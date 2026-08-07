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

async function proxyWith(t, overrides) {
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
  t.after(() => server.close())
  return { server, token, base: `http://127.0.0.1:${server.address().port}` }
}

test('宽限窗口内可以重复兑换，预取烧掉的就是第一次', async (t) => {
  const { token, base: b } = await proxyWith(t, { graceMs: 60_000 })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 302, '窗口内第二次兑换必须仍然放行')
  assert.match(second.headers.get('set-cookie'), /^mp_session=/)
})

test('宽限窗口关闭后，正确的令牌也是 404', async (t) => {
  const { token, base: b } = await proxyWith(t, { graceMs: 20 })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await new Promise((r) => setTimeout(r, 40))
  const late = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(late.status, 404)
})

test('窗口外的兑换计入限流——那正是泄漏重放的形状', async (t) => {
  const { token, base: b } = await proxyWith(t, { graceMs: 20, maxFailures: 2 })

  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await new Promise((r) => setTimeout(r, 40))
  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  // 限流已触发，此时连合法 cookie 也一并挡下
  const res = await fetch(`${b}/`, { headers: { cookie: `mp_session=${token}` } })
  assert.equal(res.status, 404)
})

test('grace 为 0 时退回一次性语义', async (t) => {
  const { token, base: b } = await proxyWith(t, { graceMs: 0 })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 404)
})

test('窗口从首次兑换开始计时，而非从签发开始', async (t) => {
  const { token, base: b } = await proxyWith(t, { graceMs: 40 })

  // 静置一段时间后才首次兑换；若窗口在签发时就已打开，此时早已关闭。
  await new Promise((r) => setTimeout(r, 60))
  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 302)
})

test('错误令牌在任何时候都是 404，且不打开窗口', async (t) => {
  const { token, base: b } = await proxyWith(t, { graceMs: 0 })

  const bad = await fetch(`${b}/?t=${mintToken()}`, { redirect: 'manual' })
  const good = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(bad.status, 404)
  assert.equal(good.status, 302, '错误令牌不应消耗掉真令牌的首次兑换')
})

test('TTL 到期优先于宽限窗口', async (t) => {
  const { token, base: b } = await proxyWith(t, {
    graceMs: 60_000,
    expiresAt: Date.now() - 1,
  })

  const res = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  assert.equal(res.status, 404)
})

test('graceMs 非有限值时退回一次性，绝不是「窗口永不关闭」（Finding 1）', async (t) => {
  // `mp start --grace 10m` used to reach here as NaN. graceUntil became NaN,
  // and since nothing is ever >= NaN the closing test never fired: every later
  // ?t= request got a fresh cookie, i.e. the URL became a permanent credential.
  const { token, base: b } = await proxyWith(t, { graceMs: NaN })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 404, '非有限的 graceMs 必须 fail closed，退化为一次性')
})

test('宽限窗口不滑动：窗口内的兑换不会重新上弦（Finding 9）', async (t) => {
  // The non-sliding property is what bounds the leak. An implementation that
  // re-armed graceUntil on every exchange would keep every other test in this
  // file green while making the window unbounded for a client that polls the
  // link — so the property needs a test of its own.
  const { token, base: b } = await proxyWith(t, { graceMs: 200 })

  await fetch(`${b}/?t=${token}`, { redirect: 'manual' }) // 开窗
  await new Promise((r) => setTimeout(r, 120))
  await fetch(`${b}/?t=${token}`, { redirect: 'manual' }) // 不得重新上弦
  await new Promise((r) => setTimeout(r, 120))

  const late = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  assert.equal(late.status, 404, '窗口应当从首次兑换起 200ms 关闭，与其后的兑换无关')
})

test('限流按 CF-Connecting-IP 分桶，不把所有远端访客并作一桶（Finding 7）', async (t) => {
  // Behind cloudflared every socket says 127.0.0.1, so keying on it made
  // maxFailures a global counter: someone else's ten bad requests locked out
  // the legitimate cookie-holder, who then saw the same opaque 404.
  const { token, base: b } = await proxyWith(t, { maxFailures: 2 })

  for (let i = 0; i < 3; i += 1) {
    await fetch(`${b}/?t=${mintToken()}`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } })
  }

  const noisy = await fetch(`${b}/`, {
    headers: { 'CF-Connecting-IP': '203.0.113.9', cookie: `mp_session=${token}` },
  })
  assert.equal(noisy.status, 404, '触发限流的那个 IP 仍应被挡下')

  const legit = await fetch(`${b}/`, {
    headers: { 'CF-Connecting-IP': '198.51.100.4', cookie: `mp_session=${token}` },
  })
  // 502 = 已经放行到目标（targetPort 1 没人监听），即未被连坐
  assert.equal(legit.status, 502, '持合法 cookie 的另一个 IP 不该被别人的失败连累')
})

test('缺少 CF-Connecting-IP 时回退到 socket 地址，限流仍然生效', async (t) => {
  const { token, base: b } = await proxyWith(t, { maxFailures: 2 })

  for (let i = 0; i < 3; i += 1) await fetch(`${b}/?t=${mintToken()}`)

  const res = await fetch(`${b}/`, { headers: { cookie: `mp_session=${token}` } })
  assert.equal(res.status, 404)
})

test('onWindowOpen 只在首次兑换时触发一次（Finding 8）', async (t) => {
  const opens = []
  const { token, base: b } = await proxyWith(t, {
    graceMs: 60_000,
    onWindowOpen: (e) => opens.push(e),
  })

  await fetch(`${b}/?t=${mintToken()}`, { redirect: 'manual' })
  assert.deepEqual(opens, [], '错误令牌不开窗，也就不该有回调')

  const before = Date.now()
  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(opens.length, 1, '窗口只开一次，回调也只能有一次')
  assert.ok(opens[0].at >= before && opens[0].at <= Date.now())
  assert.equal(opens[0].until, opens[0].at + 60_000)
})

test('onWindowOpen 抛异常不影响请求本身', async (t) => {
  const { token, base: b } = await proxyWith(t, {
    graceMs: 60_000,
    onWindowOpen: () => { throw new Error('状态文件写不进去') },
  })

  const res = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  assert.equal(res.status, 302, '记账失败绝不能把用户的请求带下水')
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
