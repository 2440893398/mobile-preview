import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProxy } from '../src/proxy.js'
import { mintToken, hashToken } from '../src/auth.js'

const galleryDir = mkdtempSync(join(tmpdir(), 'mp-fwd-'))
const sessionToken = mintToken()
let target
let targetPort
let seenHost
let seenBody

before(async () => {
  target = createServer((req, res) => {
    seenHost = req.headers.host
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      seenBody = body
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-From': 'target' })
      res.end(`${req.method} ${req.url}`)
    })
  })
  await new Promise((r) => target.listen(0, '127.0.0.1', r))
  targetPort = target.address().port
})

after(() => {
  target.close()
  rmSync(galleryDir, { recursive: true, force: true })
})

function proxyFor(dev) {
  const s = createProxy({
    galleryDir,
    galleryToken: mintToken(),
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev,
    targetPort,
  })
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)))
}

test('GET is forwarded with path preserved and response passed back', async () => {
  const s = await proxyFor(false)
  const b = `http://127.0.0.1:${s.address().port}`
  const res = await fetch(`${b}/hello/world?a=1`, { headers: { cookie: `mp_session=${sessionToken}` } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-from'), 'target')
  assert.equal(await res.text(), 'GET /hello/world?a=1')
  s.close()
})

test('Vite cache-busting `t` query is forwarded for a valid session', async () => {
  const s = await proxyFor(true)
  const b = `http://127.0.0.1:${s.address().port}`
  const res = await fetch(`${b}/src/main.ts?t=1786108570463`, {
    headers: { cookie: `mp_session=${sessionToken}` },
  })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'GET /src/main.ts?t=1786108570463')
  s.close()
})

test('POST body is forwarded intact', async () => {
  const s = await proxyFor(false)
  const b = `http://127.0.0.1:${s.address().port}`
  await fetch(`${b}/api`, {
    method: 'POST',
    headers: { cookie: `mp_session=${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hi: 1 }),
  })
  assert.equal(seenBody, '{"hi":1}')
  s.close()
})

test('dev mode rewrites Host to localhost so vite allowedHosts passes', async () => {
  const s = await proxyFor(true)
  const b = `http://127.0.0.1:${s.address().port}`
  await fetch(`${b}/`, { headers: { cookie: `mp_session=${sessionToken}` } })
  assert.equal(seenHost, `localhost:${targetPort}`)
  s.close()
})

test('non-dev mode also normalises Host to the target', async () => {
  const s = await proxyFor(false)
  const b = `http://127.0.0.1:${s.address().port}`
  await fetch(`${b}/`, { headers: { cookie: `mp_session=${sessionToken}` } })
  assert.equal(seenHost, `localhost:${targetPort}`)
  s.close()
})

test('the session cookie is not leaked to the target application', async () => {
  let sawCookie = 'unset'
  const sniff = createServer((req, res) => {
    sawCookie = req.headers.cookie ?? null
    res.end('ok')
  })
  await new Promise((r) => sniff.listen(0, '127.0.0.1', r))
  const s2 = createProxy({
    galleryDir,
    galleryToken: mintToken(),
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev: false,
    targetPort: sniff.address().port,
  })
  await new Promise((r) => s2.listen(0, '127.0.0.1', r))
  await fetch(`http://127.0.0.1:${s2.address().port}/`, {
    headers: { cookie: `mp_session=${sessionToken}; app_pref=dark` },
  })
  assert.equal(sawCookie, 'app_pref=dark', 'mp_session must be stripped, other cookies kept')
  s2.close()
  sniff.close()
})

test('a dead target yields 502 rather than a hang', async () => {
  const s = createProxy({
    galleryDir,
    galleryToken: mintToken(),
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev: false,
    targetPort: 1,
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const res = await fetch(`http://127.0.0.1:${s.address().port}/`, {
    headers: { cookie: `mp_session=${sessionToken}` },
  })
  assert.equal(res.status, 502)
  s.close()
})
