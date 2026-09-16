import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashToken, mintToken } from '../src/auth.js'
import { INTERACTION_CSP, createInteractionServer } from '../src/interaction-form.js'
import { contentDigest } from '../src/interaction-page.js'

const HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body data-mp-form><input name="city"><button data-mp-submit></button></body></html>`

const DIGEST = contentDigest(HTML)

async function withServer(overrides, fn) {
  const token = mintToken()
  const submissions = []
  const drafts = []
  const receipts = new Map()

  const server = createInteractionServer({
    html: HTML,
    requestId: 'i-abc123',
    revision: 1,
    contentDigest: DIGEST,
    sessionHash: hashToken(token),
    expiresAt: Date.now() + 60_000,
    onDraft: (d) => drafts.push(d),
    // 与 daemon 的 onSubmit 同一套规则：按 responseId 幂等，换了编号又已作答
    // 就是冲突。
    onSubmit: (s) => {
      submissions.push(s)
      const seen = receipts.get(s.responseId)
      if (seen) return { receiptId: seen, duplicate: true }
      if (receipts.size) return { conflict: true }
      const receiptId = `rc-${receipts.size + 1}`
      receipts.set(s.responseId, receiptId)
      return { receiptId, duplicate: false }
    },
    ...overrides,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const exchange = async () => {
    const res = await fetch(`${base}/?__mp_token=${token}`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    return res.headers.get('set-cookie').split(';')[0]
  }
  const post = (path, body, cookie) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  try {
    return await fn({
      base, token, cookie: exchange, post, submissions, drafts,
    })
  } finally {
    server.close()
  }
}

const answer = (over = {}) => ({
  requestId: 'i-abc123',
  revision: 1,
  contentDigest: DIGEST,
  responseId: 'resp-1',
  disposition: 'answered',
  answers: { city: 'sz' },
  ...over,
})

test('没有令牌、令牌不对、cookie 不对，一律 404，不解释', async () => {
  await withServer({}, async ({ base, post }) => {
    assert.equal((await fetch(`${base}/`)).status, 404)
    assert.equal((await fetch(`${base}/?__mp_token=${mintToken()}`)).status, 404)
    assert.equal((await post('/submit', answer())).status, 404)
    assert.equal((await fetch(`${base}/`, { headers: { Cookie: 'mp_interaction=nope' } })).status, 404)
  })
})

test('令牌换 cookie 后页面可读，带严格 CSP 且桥接已注入', async () => {
  await withServer({}, async ({ base, cookie }) => {
    const c = await cookie()
    const res = await fetch(`${base}/`, { headers: { Cookie: c } })

    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-security-policy'), INTERACTION_CSP)
    assert.equal(res.headers.get('cache-control'), 'no-store')

    const html = await res.text()
    assert.ok(html.includes('window.MP_REQUEST'), '桥接的请求对象必须在页面里')
    assert.ok(html.includes('"contentDigest":"' + DIGEST + '"'))
    assert.ok(html.includes('<input name="city">'), '页面原文必须原样送出')
  })
})

test('CSP 允许 data: 图片（内联图解），但仍然不允许任何网络来源', () => {
  assert.match(INTERACTION_CSP, /img-src data:/)
  assert.match(INTERACTION_CSP, /default-src 'none'/)
  assert.match(INTERACTION_CSP, /connect-src 'self'/)
  assert.match(INTERACTION_CSP, /form-action 'none'/)
})

test('草稿可以反复提交，页面读得到，且不算作答', async () => {
  await withServer({}, async ({ cookie, post, drafts, submissions }) => {
    const c = await cookie()
    for (const city of ['s', 'sz']) {
      const res = await post('/draft', { requestId: 'i-abc123', revision: 1, answers: { city } }, c)
      assert.equal(res.status, 204)
    }
    assert.deepEqual(drafts.map((d) => d.answers.city), ['s', 'sz'])
    assert.equal(submissions.length, 0)
  })
})

test('提交成功返回回执；之后整个服务器闭门，连页面都不再给', async () => {
  await withServer({}, async ({ base, cookie, post, submissions }) => {
    const c = await cookie()
    const res = await post('/submit', answer(), c)

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'submitted', receiptId: 'rc-1', duplicate: false })
    assert.deepEqual(submissions[0].answers, { city: 'sz' })
    assert.equal(submissions[0].disposition, 'answered')

    assert.equal((await fetch(`${base}/`, { headers: { Cookie: c } })).status, 404)
  })
})

test('同一个 responseId 重复提交拿回同一张回执，而不是第二个答案', async () => {
  await withServer({}, async ({ cookie, post, submissions }) => {
    const c = await cookie()
    const first = await (await post('/submit', answer(), c)).json()
    assert.equal(first.duplicate, false)

    // 手机在隧道抖动时重发：同一 responseId，必须幂等。
    const again = await post('/submit', answer(), c)
    assert.equal(again.status, 200)
    const body = await again.json()
    assert.equal(body.receiptId, first.receiptId)
    assert.equal(body.duplicate, true)
    assert.equal(submissions.length, 2, '两次都到达了 daemon，由它去重')

    // 但换一个 responseId 就是另一份答案了：已经作答的问题不接受第二份。
    const other = await post('/submit', answer({ responseId: 'resp-2', answers: { city: 'bj' } }), c)
    assert.equal(other.status, 409)
    assert.equal((await other.json()).status, 'stale')
  })
})

test('页面已被换掉（digest 对不上）时返回 409，不把旧问题的答案记进去', async () => {
  await withServer({}, async ({ cookie, post, submissions }) => {
    const c = await cookie()
    const res = await post('/submit', answer({ contentDigest: 'ffffffffffffffff' }), c)

    assert.equal(res.status, 409)
    assert.equal((await res.json()).status, 'stale')
    assert.equal(submissions.length, 0)
  })
})

test('requestId 不对、disposition 不认识、answers 不是对象、缺 responseId，都拒收', async () => {
  await withServer({}, async ({ cookie, post, submissions }) => {
    const c = await cookie()
    const cases = [
      [answer({ requestId: 'i-other' }), 400],
      [answer({ disposition: 'whatever' }), 400],
      [answer({ answers: ['sz'] }), 400],
      [answer({ responseId: '' }), 400],
      ['{ not json', 400],
    ]
    for (const [body, status] of cases) {
      assert.equal((await post('/submit', body, c)).status, status, JSON.stringify(body).slice(0, 40))
    }
    assert.equal(submissions.length, 0)
  })
})

test('前提不对这类提交不需要填完，也照样收下并带上原因', async () => {
  await withServer({}, async ({ cookie, post, submissions }) => {
    const c = await cookie()
    const res = await post('/submit', answer({
      disposition: 'needs_clarification', answers: {}, reason: 'premise',
    }), c)

    assert.equal(res.status, 200)
    assert.equal(submissions[0].disposition, 'needs_clarification')
    assert.equal(submissions[0].reason, 'premise')
  })
})

test('超大提交被拒且能收到 413，而不是断在半路变成「网络错误」', async () => {
  await withServer({ maxBodyBytes: 1_024 }, async ({ cookie, post }) => {
    const c = await cookie()
    // 略超上限：body 被读完丢掉，413 才送得出去。超出好几倍的才会直接断链。
    const res = await post('/submit', answer({ answers: { city: 'x'.repeat(1_500) } }), c)
    assert.equal(res.status, 413)
  })
})

test('链接过期后什么都不给', async () => {
  await withServer({ expiresAt: Date.now() - 1 }, async ({ base, token }) => {
    assert.equal((await fetch(`${base}/?__mp_token=${token}`)).status, 404)
  })
})
