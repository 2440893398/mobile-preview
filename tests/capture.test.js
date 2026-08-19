import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  capture, classifySeverity, correlateResourceErrors, dedupeRequests, guessResourceType,
} from '../src/capture.js'

let server
let base
let outDir

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/broken.js') {
      res.writeHead(500, { 'Content-Type': 'application/javascript' })
      return res.end('boom')
    }
    // A missing entry script and a missing favicon both produce the same
    // "404 (Not Found)" console line. Telling them apart is the whole point of
    // the severity split, so the fixture page requests one of each.
    if (req.url === '/missing-entry.js' || req.url === '/favicon.ico') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      return res.end('nope')
    }
    // Answers only after the load event has long passed, so a capture that
    // does not wait for the network cannot have seen it.
    if (req.url === '/slow-404') {
      // 3s, not a tighter number: the "eager capture misses it" control
      // branch below only holds if screenshot + context.close finish inside
      // this window, and under full-suite load 800ms was routinely blown.
      return setTimeout(() => {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{}')
      }, 3000)
    }
    if (req.url === '/late') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><meta charset=utf-8><h1>late</h1>
        <script>fetch('/slow-404').catch(() => {})</script>`)
    }
    // An SPA shell: the content the user cares about only exists after a tick.
    if (req.url === '/spa') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><meta charset=utf-8><div id=app></div>
        <script>setTimeout(() => {
          document.getElementById('app').innerHTML = '<p id=ready>loaded</p>'
        }, 400)</script>`)
    }
    if (req.url === '/tall') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end('<!doctype html><meta charset=utf-8><div style="height:4000px">tall</div>')
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset=utf-8>
      <h1 id=t>capture target</h1>
      <img src="/favicon.ico" alt="">
      <script>console.error('deliberate console error')</script>
      <script src="/broken.js"></script>
      <script src="/missing-entry.js"></script>`)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  outDir = mkdtempSync(join(tmpdir(), 'mp-cap-'))
})

after(() => {
  server.close()
  rmSync(outDir, { recursive: true, force: true })
})

test('produces a screenshot file and reports its basename', async () => {
  const r = await capture({ url: base, outDir })
  assert.equal(r.shots.length, 1)
  assert.equal(r.shots[0], 'shot-1.png')
  assert.ok(existsSync(join(outDir, 'shot-1.png')), 'screenshot must exist on disk')
})

test('repeat captures number their artifacts instead of overwriting earlier ones', async () => {
  // 固定的 shot-1.png 意味着第二次 capture 会覆盖第一次——已经发到手机
  // 聊天里的 markdown 链接内容被悄悄换掉。编号必须接着已有文件往下走。
  const dir2 = mkdtempSync(join(tmpdir(), 'mp-cap2-'))
  try {
    const r1 = await capture({ url: base, outDir: dir2 })
    const r2 = await capture({ url: base, outDir: dir2 })
    assert.equal(r1.shots[0], 'shot-1.png')
    assert.equal(r2.shots[0], 'shot-2.png')
    assert.ok(existsSync(join(dir2, 'shot-1.png')), '第一张必须原样留着')
    assert.ok(existsSync(join(dir2, 'shot-2.png')))
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

test('collects console errors for the agent to self-check', async () => {
  const r = await capture({ url: base, outDir })
  assert.ok(
    r.consoleErrors.some((e) => e.text.includes('deliberate console error')),
    `expected the console error, got ${JSON.stringify(r.consoleErrors)}`,
  )
})

test('collects failing network responses', async () => {
  const r = await capture({ url: base, outDir })
  assert.ok(
    r.failedRequests.some((f) => f.url.endsWith('/broken.js') && f.status === 500),
    `expected the 500, got ${JSON.stringify(r.failedRequests)}`,
  )
})

test('records a video when asked', async () => {
  const r = await capture({ url: base, outDir, video: true })
  assert.equal(r.video, 'reel.mp4')
  assert.ok(existsSync(join(outDir, r.video)), 'video must exist on disk')
})

test('an unreachable url rejects rather than returning an empty result', async () => {
  await assert.rejects(() => capture({ url: 'http://127.0.0.1:1', outDir }))
})

test('加载失败时的报错点名 url、超时预算与等待条件，而不是抛一句 Timeout', async () => {
  await assert.rejects(
    () => capture({ url: 'http://127.0.0.1:1', outDir, timeoutMs: 2000 }),
    (err) => {
      assert.match(err.message, /could not load http:\/\/127\.0\.0\.1:1/)
      assert.match(err.message, /2000ms/)
      assert.match(err.message, /waiting for "load"/)
      return true
    },
  )
})

// ---- 404 诊断：真实浏览器跑一遍 ----

test('缺失的入口脚本报出完整 url、状态码与资源类型（不是光秃秃一句 404）', async () => {
  const r = await capture({ url: base, outDir })

  const miss = r.failedRequests.find((f) => f.url.endsWith('/missing-entry.js'))
  assert.ok(miss, `expected /missing-entry.js in ${JSON.stringify(r.failedRequests, null, 2)}`)
  assert.equal(miss.status, 404)
  assert.equal(miss.resourceType, 'script')
  assert.equal(miss.severity, 'error', '业务资源缺失是错误，不是可忽略项')
})

test('favicon 的 404 降级为 warning，不和真正的错误混在一起', async () => {
  const r = await capture({ url: base, outDir })

  const favicon = r.failedRequests.find((f) => f.url.endsWith('/favicon.ico'))
  assert.ok(favicon, `expected /favicon.ico in ${JSON.stringify(r.failedRequests, null, 2)}`)
  assert.equal(favicon.severity, 'warning')
})

test('浏览器 console 里的资源错误不会再以「没有 url」的形式留下', async () => {
  const r = await capture({ url: base, outDir })

  // 这一条正是真实会话里报告的形状：console 有
  // "Failed to load resource: ... 404 (Not Found)"，failedRequests 却是空的，
  // 于是没人知道少的是 favicon 还是入口脚本。
  const orphan = r.consoleErrors.find((e) => /Failed to load resource/i.test(e.text))
  assert.equal(orphan, undefined,
    `资源错误必须并进 failedRequests，不能作为无 url 的 console 行留下：${JSON.stringify(orphan)}`)
  assert.ok(
    r.failedRequests.every((f) => typeof f.url === 'string' && f.url.startsWith('http')),
    '每一条失败记录都必须带完整 url',
  )
})

// ---- 404 诊断：纯函数，不依赖浏览器行为 ----

test('correlateResourceErrors 把 console 的资源错误折进对应的请求记录', () => {
  const r = correlateResourceErrors({
    consoleErrors: [
      { text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', url: 'http://x/app.js', line: 0 },
      { text: 'TypeError: boom', url: 'http://x/app.js', line: 12 },
    ],
    failedRequests: [{ url: 'http://x/app.js', status: 404, resourceType: 'script' }],
  })

  assert.equal(r.failedRequests.length, 1, '不能因为 console 也报了一次就重复计数')
  assert.match(r.failedRequests[0].consoleText, /404/)
  assert.deepEqual(r.consoleErrors.map((e) => e.text), ['TypeError: boom'],
    '真正的脚本错误必须原样留在 console 列表里')
})

test('console 报了资源错误但请求监听没抓到时，从 console 的 location 补出一条', () => {
  const r = correlateResourceErrors({
    consoleErrors: [{
      text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
      url: 'http://x/src/main.tsx?t=1',
      line: 0,
    }],
    failedRequests: [],
  })

  assert.equal(r.consoleErrors.length, 0)
  assert.deepEqual(r.failedRequests, [{
    url: 'http://x/src/main.tsx?t=1',
    status: 404,
    resourceType: 'script',
    consoleText: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
    fromConsole: true,
  }])
})

test('网络层失败也从 console 文本里取到 net:: 错误码', () => {
  const r = correlateResourceErrors({
    consoleErrors: [{
      text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED',
      url: 'http://127.0.0.1:9999/api/items',
      line: 0,
    }],
    failedRequests: [],
  })

  assert.equal(r.failedRequests[0].error, 'net::ERR_CONNECTION_REFUSED')
  assert.equal(r.failedRequests[0].status, undefined)
})

test('classifySeverity 只把浏览器自己要的东西降级', () => {
  assert.equal(classifySeverity('http://x/favicon.ico'), 'warning')
  assert.equal(classifySeverity('http://x/apple-touch-icon-180.png'), 'warning')
  assert.equal(classifySeverity('http://x/assets/index.js.map'), 'warning')
  assert.equal(classifySeverity('http://x/src/main.tsx'), 'error')
  assert.equal(classifySeverity('http://x/api/items'), 'error')
})

test('guessResourceType 认得 Vite 那种带 ?t= 的模块 url', () => {
  assert.equal(guessResourceType('http://x/src/main.tsx?t=1786108570463'), 'script')
  assert.equal(guessResourceType('http://x/a.css'), 'stylesheet')
  assert.equal(guessResourceType('http://x/a.js.map'), 'sourcemap')
  assert.equal(guessResourceType('http://x/api/items'), 'other')
})

test('一个 404 脚本只报一次，不会既算 404 又算 ERR_ABORTED', () => {
  // Chromium 对一个 404 的 <script> 会先给 404 响应，再给一次
  // requestfailed(net::ERR_ABORTED)——同一件事的两种说法。
  const out = dedupeRequests([
    { url: 'http://x/missing.js', status: 404, resourceType: 'script' },
    { url: 'http://x/missing.js', error: 'net::ERR_ABORTED', resourceType: 'script' },
  ])

  assert.equal(out.length, 1, '一个缺失的文件不该看起来像两个问题')
  assert.equal(out[0].status, 404)
  assert.equal(out[0].error, undefined, 'HTTP 状态码才是解释，中止只是它的后果')
})

test('纯网络层失败没有状态码可留时，错误码必须保住', () => {
  const out = dedupeRequests([
    { url: 'http://x/api', error: 'net::ERR_CONNECTION_REFUSED', resourceType: 'fetch' },
  ])

  assert.equal(out[0].error, 'net::ERR_CONNECTION_REFUSED')
})

test('dedupeRequests 合并同一 url 的重复记录并保留信息更全的那条', () => {
  const out = dedupeRequests([
    { url: 'http://x/a.js', status: 404 },
    { url: 'http://x/a.js', status: 404, resourceType: 'script', consoleText: 'Failed to load resource' },
  ])

  assert.equal(out.length, 1)
  assert.equal(out[0].resourceType, 'script')
  assert.equal(out[0].consoleText, 'Failed to load resource')
})

// ---- 等待策略 ----

function pngSize(file) {
  const buf = readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

test('--wait-for 等到选择器出现才截图，SPA 不再截到空壳', async () => {
  const r = await capture({ url: `${base}/spa`, outDir, waitFor: '#ready', waitMs: 0 })
  assert.equal(r.shots.length, 1)
})

test('--wait-for 等不到时点名选择器、url 与预算，并附上已见到的诊断', async () => {
  await assert.rejects(
    () => capture({ url: `${base}/spa`, outDir, waitFor: '#never-appears', timeoutMs: 1500 }),
    (err) => {
      assert.match(err.message, /--wait-for selector "#never-appears"/)
      assert.match(err.message, /1500ms/)
      assert.match(err.message, /still rendering|Seen so far/, '必须说明当时页面处于什么状态')
      return true
    },
  )
})

test('--full-page 截整页，默认只截首屏', async () => {
  const first = mkdtempSync(join(tmpdir(), 'mp-cap-vp-'))
  const whole = mkdtempSync(join(tmpdir(), 'mp-cap-fp-'))

  try {
    await capture({ url: `${base}/tall`, outDir: first, waitMs: 0 })
    await capture({ url: `${base}/tall`, outDir: whole, waitMs: 0, fullPage: true })

    const viewport = pngSize(join(first, 'shot-1.png'))
    const full = pngSize(join(whole, 'shot-1.png'))

    assert.ok(full.height > viewport.height,
      `整页高度 ${full.height} 应当大于首屏 ${viewport.height}`)
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(whole, { recursive: true, force: true })
  }
})

test('--network-idle 等到请求收敛，否则慢接口的失败根本不会出现在诊断里', async () => {
  const eager = await capture({ url: `${base}/late`, outDir, waitMs: 0 })
  assert.equal(
    eager.failedRequests.some((f) => f.url.endsWith('/slow-404') && f.status === 404), false,
    '不等待时截图早于响应到达，这里本就看不到它——这正是要修的漏诊',
  )

  const patient = await capture({ url: `${base}/late`, outDir, waitMs: 0, networkIdle: true })
  assert.ok(
    patient.failedRequests.some((f) => f.url.endsWith('/slow-404') && f.status === 404),
    `--network-idle 必须等到 /slow-404 的 404，实得 ${JSON.stringify(patient.failedRequests)}`,
  )
})
