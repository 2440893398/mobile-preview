import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-interaction-daemon-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const {
  interactionHealth, mintInteractionId, runInteractionDaemon,
} = await import('../src/interaction-daemon.js')
const { secretCall: ipcCall } = await import('../src/secret-client.js')
const { contentDigest } = await import('../src/interaction-page.js')

function pageWith(label) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body data-mp-form><h1>${label}</h1><input name="city"><button data-mp-submit></button></body></html>`
}

const PAGE = pageWith('一')

let ipcCounter = 0
function ipcPathFor(id) {
  ipcCounter += 1
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mp-itest-${process.pid}-${ipcCounter}-${id}`
    : join(dir, `${id}-${ipcCounter}.sock`)
}

async function withDaemon(overrides, fn) {
  const id = overrides.id || mintInteractionId()
  const exits = []
  const handle = await runInteractionDaemon({
    id,
    purpose: '决定本周先做哪件',
    html: PAGE,
    ttlMinutes: 60,
    formTtlMinutes: 5,
    closeDelayMs: 20,
    ipcPath: ipcPathFor(id),
    startTunnelFn: async () => ({ url: `https://fake-${id}.trycloudflare.com`, pid: 999_990 }),
    exitFn: (code) => exits.push(code),
    ...overrides,
  })
  try {
    return await fn({ handle, id, exits })
  } finally {
    handle.dispose()
  }
}

async function answerOn(id, handle, body) {
  const s = state.readInteraction(id)
  const base = `http://127.0.0.1:${handle.formPort()}`
  const ex = await fetch(`${base}/?__mp_token=${s.sessionToken}`, { redirect: 'manual' })
  assert.equal(ex.status, 302)
  const cookie = ex.headers.get('set-cookie').split(';')[0]
  return fetch(`${base}${body.path ?? '/submit'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      requestId: id,
      revision: s.revision,
      contentDigest: s.contentDigest,
      responseId: 'resp-1',
      disposition: 'answered',
      answers: { city: 'sz' },
      ...body,
    }),
  })
}

async function until(pred, ms = 3_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('condition not met in time')
}

test('起来之后：collecting、有链接与令牌、digest 记在案', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    const s = state.readInteraction(id)

    assert.equal(s.stage, 'collecting')
    assert.equal(s.tunnelUrl, `https://fake-${id}.trycloudflare.com`)
    assert.match(s.sessionToken, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(s.revision, 1)
    assert.equal(s.contentDigest, contentDigest(PAGE))
    assert.equal(s.daemonPid, process.pid)
    assert.ok(interactionHealth(s).active)

    const st = await ipcCall(handle.ipcPath, { op: 'status' })
    assert.equal(st.stage, 'collecting')
    assert.equal(st.revision, 1)
  })
})

test('不合规的页面根本开不起来，错误里点名问题', async () => {
  await assert.rejects(
    () => runInteractionDaemon({
      id: mintInteractionId(),
      purpose: 'x',
      html: '<!doctype html><html><body>没有提交入口</body></html>',
      startTunnelFn: async () => ({ url: 'https://x', pid: 1 }),
      exitFn: () => {},
    }),
    /interaction contract.*no way to submit/s,
  )
})

test('草稿写进状态文件，答案没来之前不算作答', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    const res = await answerOn(id, handle, { path: '/draft', answers: { city: 's' } })
    assert.equal(res.status, 204)

    await until(() => state.readInteraction(id).draft)
    const s = state.readInteraction(id)
    assert.deepEqual(s.draft.answers, { city: 's' })
    assert.equal(s.stage, 'collecting')
    assert.equal(s.response, null)
  })
})

test('提交之后：答案落在状态文件里可被读回，链接关闭，草稿清掉', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    await answerOn(id, handle, { path: '/draft', answers: { city: 's' } })
    await until(() => state.readInteraction(id).draft)

    const res = await answerOn(id, handle, {})
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'submitted')

    const s = state.readInteraction(id)
    assert.equal(s.stage, 'submitted')
    assert.deepEqual(s.response.answers, { city: 'sz' })
    assert.equal(s.response.disposition, 'answered')
    assert.equal(s.response.receiptId, body.receiptId)
    assert.equal(s.draft, null, '答案到了，草稿就不该再被当成待填')
    assert.equal(s.sessionToken, null, '令牌用过即弃')

    // 与 secret 相反：答案就是要能读回来，它必须在文件里。
    assert.match(readFileSync(state.interactionStatePath(id), 'utf8'), /"city": "sz"/)

    await until(() => state.readInteraction(id).tunnelUrl === null)
  })
})

test('链接过期而没人答，不是失败：记录留着、草稿留着、daemon 不死', async () => {
  await withDaemon({ formTtlMinutes: 0.02 }, async ({ handle, id, exits }) => {
    await answerOn(id, handle, { path: '/draft', answers: { city: '半' } })
    await until(() => state.readInteraction(id).draft)

    await until(() => state.readInteraction(id).stage === 'expired_link', 5_000)
    const s = state.readInteraction(id)

    assert.equal(s.stage, 'expired_link')
    assert.deepEqual(s.draft.answers, { city: '半' })
    assert.equal(s.tunnelUrl, null)
    assert.deepEqual(exits, [], 'daemon 不该因为链接过期就退出')
  })
})

test('重开一版：revision 加一、digest 换掉、旧答案进 history、旧页面的提交被 409 挡住', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    const before = state.readInteraction(id)
    await answerOn(id, handle, {})
    await until(() => state.readInteraction(id).stage === 'submitted')

    const NEXT = pageWith('二')
    const r = await ipcCall(handle.ipcPath, { op: 'reopen', html: NEXT })
    assert.equal(r.type, 'ok')
    assert.equal(r.revision, 2)

    await until(() => state.readInteraction(id).stage === 'collecting', 5_000)
    const s = state.readInteraction(id)
    assert.equal(s.revision, 2)
    assert.equal(s.contentDigest, contentDigest(NEXT))
    assert.notEqual(s.contentDigest, before.contentDigest)
    assert.equal(s.response, null)
    assert.equal(s.history.length, 1)
    assert.deepEqual(s.history[0].answers, { city: 'sz' })

    // 手机上还停留在第一版的那个标签页，不能拿旧 digest 回答新问题。
    const stale = await answerOn(id, handle, {
      contentDigest: before.contentDigest, responseId: 'resp-stale',
    })
    assert.equal(stale.status, 409)
    assert.equal(state.readInteraction(id).response, null)
  })
})

test('reopen 的新页面同样要过检查，不合规就原地拒绝，旧的一版不受影响', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    const r = await ipcCall(handle.ipcPath, {
      op: 'reopen',
      html: '<!doctype html><html><body>空页面</body></html>',
    })

    assert.equal(r.type, 'error')
    assert.equal(r.code, 'bad-page')
    assert.match(r.error, /no way to submit/)
    assert.equal(state.readInteraction(id).revision, 1)
    assert.equal(state.readInteraction(id).stage, 'collecting')
  })
})

test('链接还开着的时候不许换页面，否则手机上的人会答到一半被抽走', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    const r = await ipcCall(handle.ipcPath, { op: 'reopen', html: pageWith('二') })
    assert.equal(r.type, 'error')
    assert.equal(r.code, 'form-open')
    assert.equal(state.readInteraction(id).revision, 1)
  })
})

test('close 让 daemon 干净退出并清掉自己的记录', async () => {
  await withDaemon({}, async ({ handle, id, exits }) => {
    const r = await ipcCall(handle.ipcPath, { op: 'close' })
    assert.equal(r.type, 'ok')

    await until(() => exits.length > 0)
    assert.deepEqual(exits, [0])
    assert.equal(state.readInteraction(id), null)
  })
})

test('隧道起不来：记录停在 failed 且带上日志路径，退出码非零', async () => {
  const id = mintInteractionId()
  const exits = []
  await runInteractionDaemon({
    id,
    purpose: 'x',
    html: PAGE,
    ipcPath: ipcPathFor(id),
    startTunnelFn: async () => {
      const err = new Error('cloudflared 没起来')
      err.reason = 'spawn-failed'
      throw err
    },
    exitFn: (code) => exits.push(code),
  })

  const s = state.readInteraction(id)
  assert.equal(s.stage, 'failed')
  assert.equal(s.error, 'cloudflared 没起来')
  assert.equal(s.errorReason, 'spawn-failed')
  assert.deepEqual(exits, [1], '失败的记录要留给 wait 去读，所以是非零退出而不是清干净')
  state.clearInteraction(id)
})

test('未知 op 与坏 JSON 都有明确回复，不是沉默断开', async () => {
  await withDaemon({}, async ({ handle }) => {
    const r = await ipcCall(handle.ipcPath, { op: 'get' })
    assert.equal(r.type, 'error')
    assert.equal(r.code, 'unknown-op')
  })
})

test('interactionHealth 能分辨缺失、出错与过期', () => {
  assert.equal(interactionHealth(null).reason, 'missing')
  assert.equal(interactionHealth({ error: 'x' }).reason, 'error')
  assert.equal(interactionHealth({ daemonPid: 1 }).reason, 'expired')
  assert.equal(interactionHealth({ daemonPid: process.pid, expiresAt: Date.now() + 1000 }).active, true)
})

// —— 0.5.1 评审修复 ——

test('上一次重开失败留下的错误，不能被下一次重开读成自己的失败', async () => {
  let calls = 0
  await withDaemon({
    startTunnelFn: async () => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('tunnel boom'), { reason: 'test' })
      return { url: `https://fake-${calls}.trycloudflare.com`, pid: 999_990 }
    },
  }, async ({ handle, id }) => {
    await answerOn(id, handle, {})
    await until(() => state.readInteraction(id).stage === 'submitted')

    // 第一次重开：隧道起不来，错误落在记录上。
    await ipcCall(handle.ipcPath, { op: 'reopen', html: pageWith('二') })
    await until(() => state.readInteraction(id).reopenError, 5_000)

    // 第二次重开：`ask --id` 收到 ok 之后立刻开始盯记录，此刻必须已经看不到
    // 上一次的错误——否则它会把一条正在起来的链接报成失败，而那条链接谁也
    // 不会再打印一次。
    await ipcCall(handle.ipcPath, { op: 'reopen', html: pageWith('三') })
    assert.equal(state.readInteraction(id).reopenError, null)
    await until(() => state.readInteraction(id).stage === 'collecting', 5_000)
    assert.equal(state.readInteraction(id).reopenError, null)
  })
})

test('同一个页面重开（链接过期后再发一次），草稿留着——问题没变，他们填的还是答案', async () => {
  await withDaemon({ formTtlMinutes: 0.02 }, async ({ handle, id }) => {
    await answerOn(id, handle, { path: '/draft', answers: { city: 'sz' } })
    await until(() => state.readInteraction(id).draft)
    await until(() => state.readInteraction(id).stage === 'expired_link', 5_000)

    await ipcCall(handle.ipcPath, { op: 'reopen', html: PAGE })
    await until(() => state.readInteraction(id).stage === 'collecting', 5_000)
    assert.deepEqual(state.readInteraction(id).draft.answers, { city: 'sz' })
  })
})

test('换了一版页面再重开，草稿清掉——填的是另一个问题的答案了', async () => {
  await withDaemon({ formTtlMinutes: 0.02 }, async ({ handle, id }) => {
    await answerOn(id, handle, { path: '/draft', answers: { city: 'sz' } })
    await until(() => state.readInteraction(id).draft)
    await until(() => state.readInteraction(id).stage === 'expired_link', 5_000)

    await ipcCall(handle.ipcPath, { op: 'reopen', html: pageWith('二') })
    await until(() => state.readInteraction(id).stage === 'collecting', 5_000)
    assert.equal(state.readInteraction(id).draft, null)
  })
})

test('GET /state 把这台机器上的草稿交回页面——换个浏览器打开的人不该从头填', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    await answerOn(id, handle, { path: '/draft', answers: { city: 'sz' } })
    await until(() => state.readInteraction(id).draft)

    const s = state.readInteraction(id)
    const base = `http://127.0.0.1:${handle.formPort()}`
    const ex = await fetch(`${base}/?__mp_token=${s.sessionToken}`, { redirect: 'manual' })
    const cookie = ex.headers.get('set-cookie').split(';')[0]
    const res = await fetch(`${base}/state`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'waiting')
    assert.deepEqual(body.draft.answers, { city: 'sz' })

    // 没有令牌的人当然什么也拿不到。
    assert.equal((await fetch(`${base}/state`)).status, 404)
  })
})
