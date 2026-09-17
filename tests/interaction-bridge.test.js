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
