import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 桥接脚本是每个页面都要靠的那一段，而它在浏览器里跑之前谁也没跑过它：
// 别处的测试全是对字符串的断言，语法错、DOM API 用错、CSP 挡住的调用，
// 一个都发现不了。这里真的开一次浏览器，走一遍「填 → 换个浏览器打开 →
// 恢复 → 提交」。
//
// 没装浏览器就跳过，和 capture 用同一个查找逻辑。

process.env.MP_STATE_DIR = mkdtempSync(join(tmpdir(), 'mp-bridge-'))

const { createInteractionServer } = await import('../src/interaction-form.js')
const { contentDigest } = await import('../src/interaction-page.js')
const { hashToken, mintToken } = await import('../src/auth.js')
const { findBrowserExecutable } = await import('../src/browser.js')

const HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body data-mp-form>
<figure><svg viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg></figure>
<label>城市 <input name="city" required></label>
<p id="order"></p>
<button type="button" data-mp-submit>确认</button>
<p data-mp-receipt hidden></p>
<script>
document.addEventListener('mp:ready', function () {
  var saved = MP.draft('order')
  document.getElementById('order').textContent = JSON.stringify(saved || null)
  if (!saved) MP.set('order', ['a', 'b'])
})
</script>
</body></html>`

test('桥接脚本在真浏览器里走通一遍：草稿、换浏览器恢复、必填、提交', async (t) => {
  const executablePath = findBrowserExecutable()
  if (!executablePath) return t.skip('本机没有可用的 chromium')

  const { chromium } = await import('playwright')
  const token = mintToken()
  let draft = null
  let submitted = null

  const server = createInteractionServer({
    html: HTML,
    requestId: 'i-bridge1',
    revision: 1,
    contentDigest: contentDigest(HTML),
    sessionHash: hashToken(token),
    expiresAt: Date.now() + 300_000,
    draft: () => draft,
    onDraft: ({ answers }) => { draft = { answers, savedAt: Date.now() } },
    onSubmit: (s) => { submitted = s; return { receiptId: 'rc-bridge', duplicate: false } },
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch({ executablePath })
  const errors = []
  try {
    const phone = { viewport: { width: 390, height: 844 } }
    const first = await browser.newContext(phone)
    const page = await first.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    await page.goto(`${base}/?__mp_token=${token}`)
    // 必填没填就提交：拦住，而且不算一次作答。
    await page.click('[data-mp-submit]')
    await page.waitForTimeout(200)
    assert.equal(submitted, null, 'required 没填就不该发出去')

    await page.fill('input[name=city]', '深圳')
    await page.waitForTimeout(1200)
    assert.deepEqual(draft.answers, { city: '深圳', order: ['a', 'b'] }, '草稿要同时带上原生控件和 MP.set 的值')

    // 在聊天软件内置浏览器里填了一半，再用 Safari 打开同一条链接：那边没有
    // localStorage，只有这台机器上的那份草稿救得了他。
    const second = await browser.newContext(phone)
    const reopened = await second.newPage()
    reopened.on('pageerror', (e) => errors.push(String(e)))
    await reopened.goto(`${base}/?__mp_token=${token}`)
    await reopened.waitForTimeout(600)
    assert.equal(await reopened.inputValue('input[name=city]'), '深圳')
    assert.equal(await reopened.textContent('#order'), '["a","b"]', '自定义控件要能从 MP.draft 拿回自己的值')

    await reopened.click('[data-mp-submit]')
    await reopened.waitForTimeout(600)
    assert.equal(submitted.disposition, 'answered')
    assert.deepEqual(submitted.answers, { city: '深圳', order: ['a', 'b'] },
      '从服务端恢复的自定义值必须回到答案里，而不是只显示在屏幕上')
    assert.match(await reopened.textContent('[data-mp-receipt]'), /已提交/)
    assert.deepEqual(errors, [], '严格 CSP 下不该有控制台错误')
  } finally {
    await browser.close()
    server.close()
  }
})

// 下面两条测的是「送不出去」那条路。用路由拦截来造，而不是真去掐 cloudflared：
// 手机上遇到的就是这两种回应——隧道在重连时回来的一页不是 JSON 的错误，和这台
// 机器明确说「不收」。第一种必须自己重试，第二种重试也没用，都不能让填了半天
// 的人只剩「重新要一条链接再填一遍」这一个选择。

async function onPhone(t, run) {
  const executablePath = findBrowserExecutable()
  if (!executablePath) {
    t.skip('本机没有可用的 chromium')
    return
  }

  const { chromium } = await import('playwright')
  const token = mintToken()
  let submitted = null

  const server = createInteractionServer({
    html: HTML,
    requestId: 'i-bridge2',
    revision: 3,
    contentDigest: contentDigest(HTML),
    sessionHash: hashToken(token),
    expiresAt: Date.now() + 300_000,
    draft: () => null,
    onDraft: () => {},
    onSubmit: (s) => { submitted = s; return { receiptId: 'rc-retry', duplicate: false } },
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch({ executablePath })
  const errors = []
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    // 这两条测试是故意把请求打失败的，浏览器为此记的那行网络日志不算页面出错。
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      if (m.text().indexOf('Failed to load resource') === 0) return
      errors.push(m.text())
    })
    await run({
      page, base, token, errors, submitted: () => submitted,
    })
  } finally {
    await browser.close()
    server.close()
  }
}

async function until(page, selector, re, ms = 10_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const text = (await page.textContent(selector).catch(() => '')) || ''
    if (re.test(text)) return text
    if (Date.now() > deadline) return text
    await page.waitForTimeout(150)
  }
}

test('隧道断二十秒不该让答案丢掉：页面自己重试，人不用再点一次', async (t) => {
  await onPhone(t, async ({
    page, base, token, errors, submitted,
  }) => {
    let tries = 0
    await page.route('**/submit', async (route) => {
      tries += 1
      // cloudflared 在重连时回的就是这种东西：不是 200，也不是 JSON。
      // 这条路上什么都没被拒绝——它根本没到这台机器。
      if (tries === 1) {
        return route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Error 1033</body></html>' })
      }
      return route.continue()
    })

    await page.goto(`${base}/?__mp_token=${token}`)
    await page.fill('input[name=city]', '深圳')
    await page.click('[data-mp-submit]')

    assert.match(await until(page, '[data-mp-receipt]', /已提交/), /已提交/, '重试要把答案送到，而不是让用户重来')
    assert.ok(tries >= 2, '第一次没送到，就该自己再送一次')
    assert.equal(submitted().disposition, 'answered')
    assert.equal(await page.isVisible('#mp-handoff'), false, '送到了就不该再弹回传面板')
    assert.deepEqual(errors, [], '严格 CSP 下不该有控制台错误')
  })
})

test('一直送不出去时，答案变成一段可以粘回对话里的话', async (t) => {
  await onPhone(t, async ({
    page, base, token, errors,
  }) => {
    await page.route('**/submit', (route) => route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'rejected', error: '提交格式不对' }),
    }))

    await page.goto(`${base}/?__mp_token=${token}`)
    await page.fill('input[name=city]', '深圳')
    await page.click('[data-mp-submit]')
    await page.waitForSelector('#mp-handoff', { timeout: 10_000 })

    const text = await page.inputValue('#mp-handoff textarea')
    assert.match(text, /mp interaction 回传 · i-bridge2 · 第 3 版/)
    assert.match(text, /- 城市：深圳/, '给人看的那份要用页面上的标签，不是 name')
    assert.match(text, /mp interaction close --id i-bridge2/)

    // 给 agent 看的那份：一行 JSON，不用去猜中文里哪个词是答案。
    const line = text.split('\n').filter((l) => l.indexOf('mp-answer: ') === 0)[0]
    const payload = JSON.parse(line.slice('mp-answer: '.length))
    assert.equal(payload.id, 'i-bridge2')
    assert.equal(payload.revision, 3)
    assert.equal(payload.disposition, 'answered')
    assert.deepEqual(payload.answers, { city: '深圳', order: ['a', 'b'] }, '自定义控件的值也要在回传里')

    // 面板弹出来了，草稿一个字都不能丢：人可能选择再试一次。
    assert.equal(await page.inputValue('input[name=city]'), '深圳')
    assert.deepEqual(errors, [], '严格 CSP 下不该有控制台错误')
  })
})
