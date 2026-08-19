import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProxy } from '../src/proxy.js'
import { mintToken, hashToken } from '../src/auth.js'

// The whole chain a phone actually walks on a Vite dev server: exchange the
// link for a cookie, load the html, then load the module urls Vite writes into
// it — which carry `?t=<timestamp>` for cache-busting. That collision with the
// preview's own `?t=<token>` is what produced a blank page in dev mode, so the
// regression is pinned end to end rather than at the one handler that changed.

const galleryDir = mkdtempSync(join(tmpdir(), 'mp-vite-'))
let dev
let devPort

const INDEX_HTML = `<!doctype html>
<html><head><script type="module" src="/@vite/client"></script></head>
<body><div id="app"></div>
<script type="module" src="/src/main.tsx?t=1786108570463"></script>
</body></html>`

before(async () => {
  dev = createServer((req, res) => {
    const path = req.url.split('?')[0]

    if (path === '/@vite/client') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      return res.end('export const hmr = true')
    }
    if (path === '/src/main.tsx') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      // Echo the query back so the test can prove the proxy forwarded it
      // untouched rather than stripping it as a spent auth token.
      return res.end(`export const query = ${JSON.stringify(req.url)}`)
    }
    if (path === '/api/items') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end('[]')
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(INDEX_HTML)
  })
  await new Promise((r) => dev.listen(0, '127.0.0.1', r))
  devPort = dev.address().port
})

after(() => {
  dev.close()
  rmSync(galleryDir, { recursive: true, force: true })
})

async function preview(t, overrides = {}) {
  const token = mintToken()
  const server = createProxy({
    galleryDir,
    galleryToken: mintToken(),
    sessionHash: hashToken(token),
    expiresAt: Date.now() + 60_000,
    graceMs: 60_000,
    dev: true,
    targetPort: devPort,
    ...overrides,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return { token, base: `http://127.0.0.1:${server.address().port}` }
}

async function exchange(base, token, param = '__mp_token') {
  const res = await fetch(`${base}/?${param}=${token}`, { redirect: 'manual' })
  const cookie = res.headers.get('set-cookie')
  return { res, cookie: cookie ? cookie.split(';')[0] : null }
}

test('Vite 开发服务器全链路：兑换 → 拿 html → 拿带 ?t= 的模块', async (t) => {
  const { token, base } = await preview(t)

  const { res: redirect, cookie } = await exchange(base, token)
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), '/', '兑换后必须落到干净路径，不能把令牌留在地址栏')
  assert.ok(cookie, '必须下发会话 cookie')

  const html = await fetch(`${base}/`, { headers: { cookie } })
  assert.equal(html.status, 200)
  assert.match(await html.text(), /src\/main\.tsx\?t=1786108570463/)

  // 这一步就是此前的空白页：Vite 的 ?t=<timestamp> 曾被当成一个错误的预览令牌，
  // 于是入口模块 404，页面什么都渲染不出来。
  const mod = await fetch(`${base}/src/main.tsx?t=1786108570463`, { headers: { cookie } })
  assert.equal(mod.status, 200, 'Vite 的模块 url 必须放行')
  assert.match(await mod.text(), /main\.tsx\?t=1786108570463/, '查询串必须原样转发给 Vite')
})

test('dev 模式放行 /@vite/client，非 dev 模式仍然封死', async (t) => {
  const devPreview = await preview(t)
  const { cookie } = await exchange(devPreview.base, devPreview.token)
  const okRes = await fetch(`${devPreview.base}/@vite/client`, { headers: { cookie } })
  assert.equal(okRes.status, 200)

  const prod = await preview(t, { dev: false })
  const prodCookie = (await exchange(prod.base, prod.token)).cookie
  const blocked = await fetch(`${prod.base}/@vite/client`, { headers: { cookie: prodCookie } })
  assert.equal(blocked.status, 404, '构建产物预览不该暴露 dev 端点')
})

test('没有会话 cookie 时，Vite 形状的 ?t=<timestamp> 不构成任何绕过', async (t) => {
  const { base } = await preview(t)

  const res = await fetch(`${base}/src/main.tsx?t=1786108570463`)

  assert.equal(res.status, 404, '无凭证就是 404，时间戳不能变成免票')
})

test('旧的 ?t=<token> 预览链接仍然可以兑换（兼容不能只写在文档里）', async (t) => {
  const { token, base } = await preview(t)

  const { res, cookie } = await exchange(base, token, 't')

  assert.equal(res.status, 302)
  assert.ok(cookie, '历史链接必须照常拿到 cookie')

  const html = await fetch(`${base}/`, { headers: { cookie } })
  assert.equal(html.status, 200)
})

test('相对路径的 API 请求照常穿过隧道——这是手机端能用的前提', async (t) => {
  const { token, base } = await preview(t)
  const { cookie } = await exchange(base, token)

  const api = await fetch(`${base}/api/items`, { headers: { cookie } })

  assert.equal(api.status, 200)
  assert.equal(await api.text(), '[]')
})
