import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_JS, DISPOSITIONS, MAX_PAGE_BYTES, buildPage, checkPage, contentDigest, jsonForScript,
} from '../src/interaction-page.js'

// 页面约定：docs/superpowers/specs/2026-09-16-interaction-page-contract.md
// 这里守的是「什么页面能被放到手机前面」。凡是能让用户打开一个答不了的页面的
// 写法，都必须在发链接之前被拦下，而不是等人拿着手机才发现。

const GOOD = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title>
<style>body{font-size:16px}</style></head>
<body data-mp-form>
<label>日期 <input type="date" name="date" required></label>
<p data-mp-receipt hidden></p>
<button type="button" data-mp-submit>确认</button>
</body></html>`

function problemsOf(html) {
  return checkPage(html).problems.join(' | ')
}

test('一个合规页面通过检查，且不留警告', () => {
  const r = checkPage(GOOD)
  assert.equal(r.ok, true, r.problems.join('; '))
  assert.deepEqual(r.warnings, [])
  assert.equal(r.bytes, Buffer.byteLength(GOOD, 'utf8'))
})

test('外部资源一律拒绝：脚本、样式、字体、图片都会在隧道后失败或泄漏', () => {
  for (const tag of [
    '<script src="https://unpkg.com/react@18/umd/react.js"></script>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">',
    '<img src="https://example.com/a.png">',
    '<script src="//cdn.jsdelivr.net/x.js"></script>',
  ]) {
    const p = problemsOf(GOOD.replace('</body>', `${tag}</body>`))
    assert.match(p, /external resources are not allowed/, `应当拦下 ${tag}`)
  }
})

test('样式表里的外链同样拒绝——@import 和 url() 都绕不过去', () => {
  assert.match(problemsOf(GOOD.replace('body{', '@import url("https://x/y.css");body{')), /external URL/)
  assert.match(problemsOf(GOOD.replace('body{', 'body{background:url(https://x/y.png);')), /external URL/)
})

test('会让桥接脚本提交到别处的写法被拒绝：base href、module、form action', () => {
  assert.match(problemsOf(GOOD.replace('<title>', '<base href="https://evil.example/"><title>')), /base href/)
  assert.match(problemsOf(GOOD.replace('<style>', '<script type="module">let a=1</script><style>')), /type="module"/)
  assert.match(
    problemsOf(GOOD.replace('<label>', '<form action="/x"><label>').replace('</body>', '</form></body>')),
    /form-action/,
  )
})

test('React/Babel 被点名拒绝，因为它们只能从 CDN 来', () => {
  assert.match(problemsOf(GOOD.replace('<style>', '<script type="text/babel">1</script><style>')), /React and Babel/)
})

test('没有提交入口、没有答案载体的页面都是死页面', () => {
  const noSubmit = GOOD.replace('data-mp-submit', 'class="x"')
  assert.match(problemsOf(noSubmit), /no way to submit/)

  const noCarrier = GOOD.replace('<label>日期 <input type="date" name="date" required></label>', '<p>只有字</p>')
  assert.match(problemsOf(noCarrier), /no answer carriers/)
})

test('三种答案载体都算数：name、data-mp-value、MP.set', () => {
  const base = GOOD.replace('<label>日期 <input type="date" name="date" required></label>', 'CARRIER')
  assert.equal(checkPage(base.replace('CARRIER', '<div name="order" data-mp-value="[]"></div>')).ok, true)
  assert.equal(checkPage(base.replace('CARRIER', '<script>MP.set("order", [])</script>')).ok, true)
  assert.match(problemsOf(base.replace('CARRIER', '<div>nothing</div>')), /no answer carriers/)
})

test('页面自带 MP 或 MP_REQUEST 会被拒绝——它们是注入的，重定义等于把桥接顶掉', () => {
  assert.match(problemsOf(GOOD.replace('</body>', '<script>window.MP={}</script></body>')), /injected/)
  assert.match(problemsOf(GOOD.replace('</body>', '<script>window.MP_REQUEST={}</script></body>')), /injected/)
})

test('doctype 与 viewport 缺一不可；lang 与 </body> 只是提醒', () => {
  assert.match(problemsOf(GOOD.replace('<!doctype html>\n', '')), /doctype/)
  assert.match(problemsOf(GOOD.replace(/<meta name="viewport"[^>]*>/, '')), /viewport/)

  const warned = checkPage(GOOD.replace('<html lang="zh">', '<html>'))
  assert.equal(warned.ok, true)
  assert.match(warned.warnings.join(' '), /lang/)
})

test('超过体积上限的页面被拒绝，并把实际大小说出来', () => {
  const fat = GOOD.replace('</body>', `<p>${'账'.repeat(MAX_PAGE_BYTES)}</p></body>`)
  const r = checkPage(fat)
  assert.equal(r.ok, false)
  assert.match(r.problems.join(' '), /KB; the limit is 300 KB/)
})

test('buildPage 把请求与桥接插在 </body> 之前，页面原文一字不动', () => {
  const req = { requestId: 'i-abc123', revision: 2, contentDigest: 'deadbeefdeadbeef' }
  const out = buildPage(GOOD, req)

  assert.ok(out.startsWith('<!doctype html>'))
  assert.ok(out.indexOf('window.MP_REQUEST') < out.indexOf('</body>'), '注入必须在 </body> 之前')
  assert.ok(out.includes('"requestId":"i-abc123"'))
  assert.ok(out.includes(BRIDGE_JS))
  assert.ok(out.includes('<button type="button" data-mp-submit>确认</button>'), '原文不得被改写')
})

test('没有 </body> 的页面也能挂上桥接，而不是悄悄丢掉它', () => {
  const out = buildPage('<!doctype html><html><body><button data-mp-submit></button>', { requestId: 'i-1' })
  assert.ok(out.includes('window.MP_REQUEST'))
})

test('注入的 JSON 关不掉外面的 script 标签', () => {
  const nasty = jsonForScript({ requestId: '</script><script>alert(1)</script>' })
  assert.ok(!nasty.includes('</script>'))
  assert.ok(nasty.includes('\\u003c'))
})

test('桥接脚本自身不能含 </script>，否则注入即破', () => {
  assert.ok(!BRIDGE_JS.includes('</script>'))
})

test('contentDigest 随内容变化，是 revision 之间的凭据', () => {
  assert.equal(contentDigest(GOOD), contentDigest(GOOD))
  assert.notEqual(contentDigest(GOOD), contentDigest(`${GOOD} `))
  assert.match(contentDigest(GOOD), /^[0-9a-f]{16}$/)
})

test('disposition 的取值里必须有「前提不对」这一类，不能只能回答', () => {
  assert.ok(DISPOSITIONS.includes('answered'))
  assert.ok(DISPOSITIONS.includes('needs_clarification'))
})
