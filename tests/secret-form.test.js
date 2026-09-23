import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashToken, mintToken } from '../src/auth.js'
import { createFormServer, presetDays, renderFormPage } from '../src/secret-form.js'
import { BROWSER_ENCRYPT_JS, decryptSubmission, generateServerKeys } from '../src/secret-crypto.js'

const mpEncrypt = new Function(`${BROWSER_ENCRYPT_JS}; return mpEncrypt`)()

const FIELDS = [{ name: 'OSS_KEY', kind: 'secret' }, { name: 'BUCKET', kind: 'text' }]
const USES = ['npm run deploy', 'node check.js']

async function withForm(overrides, fn) {
  const token = mintToken()
  const keys = generateServerKeys()
  const submissions = []
  const server = createFormServer({
    purpose: '配置 OSS 上传',
    fields: FIELDS,
    uses: USES,
    sessionHash: hashToken(token),
    expiresAt: Date.now() + 60_000,
    graceMs: 60_000,
    publicJwk: keys.publicJwk,
    decrypt: (p) => decryptSubmission(keys.privateKey, p, FIELDS.map((f) => f.name)),
    onSubmit: (s) => submissions.push(s),
    ...overrides,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn({ base, token, keys, submissions })
  } finally {
    server.close()
  }
}

async function exchange(base, token) {
  const res = await fetch(`${base}/?__mp_token=${token}`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  const cookie = res.headers.get('set-cookie').split(';')[0]
  return cookie
}

async function post(base, cookie, body) {
  return fetch(`${base}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('没有令牌一律 404，包括 POST', async () => {
  await withForm({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/`)).status, 404)
    assert.equal((await post(base, null, { uses: [] })).status, 404)
    assert.equal((await fetch(`${base}/?__mp_token=${'b'.repeat(43)}`)).status, 404)
  })
})

test('令牌兑换 cookie 后能拿到页面：含用途、字段名、公钥，且带 noindex 与 CSP', async () => {
  await withForm({}, async ({ base, token, keys }) => {
    const cookie = await exchange(base, token)
    assert.match(cookie, /^mp_secret=/)

    const res = await fetch(`${base}/`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow')
    assert.match(res.headers.get('content-security-policy'), /connect-src 'self'/)
    const html = await res.text()
    assert.match(html, /配置 OSS 上传/)
    assert.match(html, /OSS_KEY/)
    assert.match(html, /type="password"/)
    assert.match(html, /npm run deploy/)
    assert.ok(html.includes(keys.publicJwk.x), '页面必须内联服务端公钥')
    assert.ok(!html.includes('"d"'), '页面绝不能带私钥')
  })
})

test('完整提交：浏览器侧加密 → 服务端解密 → onSubmit 拿到值与勾选的用途；之后一切 404', async () => {
  await withForm({}, async ({ base, token, keys, submissions }) => {
    const cookie = await exchange(base, token)
    const enc = await mpEncrypt(keys.publicJwk, { OSS_KEY: 'LTAI5t9f3c1e0b2a', BUCKET: 'my-bucket' })

    const res = await post(base, cookie, { ...enc, uses: ['npm run deploy'] })
    assert.equal(res.status, 200, await res.text())
    assert.deepEqual(submissions, [{
      values: { OSS_KEY: 'LTAI5t9f3c1e0b2a', BUCKET: 'my-bucket' },
      uses: ['npm run deploy'],
      files: [],
      keep: [],
      save: null,
      passphrase: null,
    }])

    assert.equal((await post(base, cookie, { ...enc, uses: [] })).status, 404, '只接受一次提交')
    assert.equal((await fetch(`${base}/`, { headers: { Cookie: cookie } })).status, 404)
    assert.equal((await fetch(`${base}/?__mp_token=${token}`, { redirect: 'manual' })).status, 404)
  })
})

test('勾选了未提供的用途、坏 JSON、超大请求体都被拒绝且不算提交', async () => {
  await withForm({}, async ({ base, token, keys, submissions }) => {
    const cookie = await exchange(base, token)
    const enc = await mpEncrypt(keys.publicJwk, { OSS_KEY: 'LTAI5t9f3c1e0b2a', BUCKET: '' })

    assert.equal((await post(base, cookie, { ...enc, uses: ['rm -rf /'] })).status, 400)
    assert.equal((await post(base, cookie, '{ nope')).status, 400)
    assert.equal((await post(base, cookie, { ...enc, uses: 'npm run deploy' })).status, 400)
    assert.equal((await post(base, cookie, JSON.stringify({ pad: 'x'.repeat(70_000) }))).status, 413)
    assert.equal(submissions.length, 0)

    const ok = await post(base, cookie, { ...enc, uses: [] })
    assert.equal(ok.status, 200, '拒绝过之后同一份合法提交仍然可以成功')
    assert.equal(submissions.length, 1)
  })
})

test('secret 字段不能为空，text 字段可以', async () => {
  await withForm({}, async ({ base, token, keys, submissions }) => {
    const cookie = await exchange(base, token)
    const empty = await mpEncrypt(keys.publicJwk, { OSS_KEY: '', BUCKET: '' })
    const res = await post(base, cookie, { ...empty, uses: [] })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /OSS_KEY 不能为空/)
    assert.equal(submissions.length, 0)
  })
})

test('解密失败（用别的公钥加密）返回 400，不写入任何值', async () => {
  await withForm({}, async ({ base, token, submissions }) => {
    const cookie = await exchange(base, token)
    const other = generateServerKeys()
    const enc = await mpEncrypt(other.publicJwk, { OSS_KEY: 'LTAI5t9f3c1e0b2a', BUCKET: 'b' })
    const res = await post(base, cookie, { ...enc, uses: [] })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /解密失败/)
    assert.equal(submissions.length, 0)
  })
})

test('grace 0 保留一次性语义：第二次兑换 404', async () => {
  await withForm({ graceMs: 0 }, async ({ base, token }) => {
    await exchange(base, token)
    assert.equal((await fetch(`${base}/?__mp_token=${token}`, { redirect: 'manual' })).status, 404)
  })
})

test('过期后一切 404', async () => {
  await withForm({ expiresAt: Date.now() - 1 }, async ({ base, token }) => {
    assert.equal((await fetch(`${base}/?__mp_token=${token}`, { redirect: 'manual' })).status, 404)
  })
})

test('错令牌计入限流：十次之后连正确令牌也 404', async () => {
  await withForm({ maxFailures: 3 }, async ({ base, token }) => {
    for (let i = 0; i < 3; i += 1) {
      await fetch(`${base}/?__mp_token=${'c'.repeat(43)}`, { redirect: 'manual' })
    }
    assert.equal((await fetch(`${base}/?__mp_token=${token}`, { redirect: 'manual' })).status, 404)
  })
})

test('approve 模式：页面不含输入框、列出已保存字段名，提交只带用途', async () => {
  await withForm({
    mode: 'approve', fields: [], savedFields: ['OSS_KEY'], uses: ['node deploy.js'], decrypt: null,
  }, async ({ base, token, submissions }) => {
    const cookie = await exchange(base, token)
    const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text()
    assert.doesNotMatch(html, /type="password"/)
    assert.match(html, /已保存的字段/)
    assert.match(html, /OSS_KEY/)
    assert.match(html, /node deploy\.js/)

    const res = await post(base, cookie, { uses: ['node deploy.js'] })
    assert.equal(res.status, 200)
    assert.deepEqual(submissions, [{
      values: null, uses: ['node deploy.js'], files: [], keep: [], save: null, passphrase: null,
    }])
  })
})

test('renderFormPage 对 purpose 与用途做 HTML 转义，并不让 JSON 关闭 script 标签', () => {
  const html = renderFormPage({
    purpose: '<img src=x onerror=alert(1)>',
    fields: [{ name: 'K', kind: 'secret' }],
    uses: ['echo </script><script>alert(1)</script>'],
    publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  })
  assert.doesNotMatch(html, /<img src=x/)
  assert.ok(!html.includes('</script><script>alert'), '用途文本进了 JSON 也不能闭合 script')
})

// 2026-09-21 在手机视口里真点出来的：页面脚本曾经声明全局 `var status`，而那是
// window.status —— 一个字符串属性。之后所有 status.textContent = … 都静默失效，
// 表单上从来不显示任何提示，包括服务端返回的 400。
test('页面脚本不声明全局 status（那是 window.status，赋值会静默失效）', () => {
  for (const mode of ['fill', 'confirm', 'approve']) {
    const html = renderFormPage({
      purpose: 'p', mode, fields: [{ name: 'K', kind: 'secret' }], publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    })
    assert.doesNotMatch(html, /(?:var|let|const)\s+status\b/)
    assert.doesNotMatch(html, /[^.\w]status\.textContent/)
  }
})

// 有效期原来总默认 90 天：存了 7 天的生产密钥，下次留用它、直接提交，就被
// 重新封成 90 天；「不过期」的也被改成 90 天。默认值要跟着上次的选择走。
const DAY = 86_400_000
const meta = (days, level = 'auto') => ({
  level, status: 'saved', length: 8, sha256_8: 'abcd1234', savedAt: 1_000, expiresAt: days ? 1_000 + days * DAY : null,
})

test('presetDays：沿用上次选的有效期，多个字段取最短', () => {
  assert.equal(presetDays([meta(7)]), 7)
  assert.equal(presetDays([meta(0)]), 0, '不过期就还是不过期')
  assert.equal(presetDays([meta(90), meta(7)]), 7)
  assert.equal(presetDays([meta(0), meta(30)]), 30)
  assert.equal(presetDays([{ ...meta(7), expiresAt: 1_000 + 8 * DAY }]), 7, '对不上的天数就近取一档')
})

test('填写页：已保存字段的有效期被预选，而不是 90 天', () => {
  const checked = (html) => /name="days" value="(\d+)" checked/.exec(html)?.[1]
  const page = (saved) => renderFormPage({
    purpose: 'p',
    mode: 'fill',
    fields: [{ name: 'K', kind: 'secret' }, { name: 'NEW', kind: 'secret' }],
    saved,
    save: { available: true, passphraseSet: false },
    publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  })
  assert.equal(checked(page({ K: meta(7) })), '7')
  assert.equal(checked(page({ K: meta(0) })), '0')
  assert.equal(checked(page({})), '90', '没保存过的还是默认 90 天')
})
