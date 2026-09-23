import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 真 daemon 跑在测试进程里（隧道是假的），CLI 作为子进程通过命名管道/socket 找
// 它：ask / wait / status / close 走的就是 agent 走的那条路。CLI 必须异步启动 ——
// spawnSync 会卡住测试进程的事件循环，而 daemon 就在这个事件循环上答话。

const dir = mkdtempSync(join(tmpdir(), 'mp-interaction-cli-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const { mintInteractionId, runInteractionDaemon } = await import('../src/interaction-daemon.js')
const {
  formatInteractionAsk, formatInteractionStatus, formatInteractionWait, interactionUrl,
  localInteractionUrl,
} = await import('../src/interaction-cli.js')

const BIN = fileURLToPath(new URL('../src/bin.js', import.meta.url))
const NODE = process.execPath

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body data-mp-form><h1>先做哪件</h1><input name="city"><button data-mp-submit>确认</button></body></html>`

function pageFile(name, html = PAGE) {
  const f = join(dir, name)
  writeFileSync(f, html, 'utf8')
  return f
}

// 45 秒不是这些命令要跑这么久，而是整个套件并行跑的时候，一个要 spawn 子
// 进程的测试会和别人抢 CPU。超时太紧，失败的是机器负载，不是代码。
function mp(args, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [BIN, ...args], {
      env: { ...process.env, MP_STATE_DIR: dir },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

let ipcCounter = 0
function ipcPathFor(id) {
  ipcCounter += 1
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mp-iclitest-${process.pid}-${ipcCounter}-${id}`
    : join(dir, `${id}-${ipcCounter}.sock`)
}

// daemon 跑在测试进程里，放着不管它记下的 daemonPid 就是测试进程自己。而
// `close` 等 daemon 清记录只等一秒，等不到就 taskkill /T /F 那个 pid——全套
// 并行跑、CPU 吃紧的时候这一秒真的会用完，测试进程于是把自己杀了：文件退出码 1，
// 跑到一半，没有一个测试报错（2026-09-21）。所以每个 daemon 记一个替身子进程的
// pid；真要杀，杀的是替身。
const standIns = []
after(() => { for (const c of standIns) c.kill() })
function standIn() {
  const c = spawn(NODE, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true })
  standIns.push(c)
  return c
}

async function startDaemon(overrides = {}) {
  const id = overrides.id || mintInteractionId()
  const holder = standIn()
  const handle = await runInteractionDaemon({
    ownerPid: holder.pid,
    id,
    purpose: '决定本周先做哪件',
    html: PAGE,
    ttlMinutes: 60,
    formTtlMinutes: 5,
    closeDelayMs: 20,
    ipcPath: ipcPathFor(id),
    startTunnelFn: async () => ({ url: `https://fake-${id}.trycloudflare.com`, pid: 999_990 }),
    exitFn: () => {},
    ...overrides,
  })
  return { id, handle }
}

async function submit(id, handle, over = {}) {
  const s = state.readInteraction(id)
  const base = `http://127.0.0.1:${handle.formPort()}`
  const ex = await fetch(`${base}/?__mp_token=${s.sessionToken}`, { redirect: 'manual' })
  const cookie = ex.headers.get('set-cookie').split(';')[0]
  const res = await fetch(`${base}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      requestId: id,
      revision: s.revision,
      contentDigest: s.contentDigest,
      responseId: 'resp-1',
      disposition: 'answered',
      answers: { city: 'sz' },
      ...over,
    }),
  })
  assert.equal(res.status, 200, await res.text())
}

test('ask 拒绝不合规的页面，逐条说明为什么，而且不会起 daemon', async () => {
  const bad = pageFile('bad.html', '<!doctype html><html><body><p>只有一段话</p></body></html>')
  const res = await mp(['interaction', 'ask', '--purpose', 'x', '--html', bad])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /does not meet the interaction page contract/)
  assert.match(res.stderr, /viewport/)
  assert.match(res.stderr, /no way to submit/)
  assert.equal(state.listInteractions().length, 0, '页面没过检查就不该留下任何记录')
})

test('ask 读不到文件时直接说读不到，而不是留一个半截记录', async () => {
  const res = await mp(['interaction', 'ask', '--purpose', 'x', '--html', join(dir, 'nope.html')])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /could not read/)
})

test('ask 缺 --html 或缺 --purpose 都要点名', async () => {
  const a = await mp(['interaction', 'ask', '--purpose', 'x'])
  assert.equal(a.status, 1)
  assert.match(a.stderr, /--html is required/)

  const b = await mp(['interaction', 'ask', '--html', pageFile('ok.html')])
  assert.equal(b.status, 1)
  assert.match(b.stderr, /--purpose is required/)
})

test('wait 在答案到达后打印结构化答案，退出码 0，并记下已交付', async () => {
  const { id, handle } = await startDaemon()
  try {
    await submit(id, handle)

    const res = await mp(['interaction', 'wait', '--id', id, '--json'])
    assert.equal(res.status, 0, res.stderr)
    const payload = JSON.parse(res.stdout)

    assert.equal(payload.status, 'submitted')
    assert.equal(payload.id, id)
    assert.equal(payload.disposition, 'answered')
    assert.deepEqual(payload.answers, { city: 'sz' })
    assert.equal(payload.revision, 1)
    assert.ok(payload.receiptId)
    assert.ok(state.readInteraction(id).deliveredAt, '读过之后要记下来，status 才说得清')
  } finally {
    handle.dispose()
  }
})

test('同一个答案可以被 wait 反复读回——上下文被压缩掉的那份不能是唯一一份', async () => {
  const { id, handle } = await startDaemon()
  try {
    await submit(id, handle)

    const first = JSON.parse((await mp(['interaction', 'wait', '--id', id, '--json'])).stdout)
    const again = await mp(['interaction', 'wait', '--id', id, '--json'])

    assert.equal(again.status, 0)
    const second = JSON.parse(again.stdout)
    assert.equal(second.receiptId, first.receiptId)
    assert.deepEqual(second.answers, first.answers)
  } finally {
    handle.dispose()
  }
})

test('wait 超时不是错误：退出码 0、状态 waiting，并把已填的部分带回来', async () => {
  const { id, handle } = await startDaemon()
  try {
    const s = state.readInteraction(id)
    const base = `http://127.0.0.1:${handle.formPort()}`
    const ex = await fetch(`${base}/?__mp_token=${s.sessionToken}`, { redirect: 'manual' })
    const cookie = ex.headers.get('set-cookie').split(';')[0]
    await fetch(`${base}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ requestId: id, revision: 1, answers: { city: '还在想' } }),
    })

    const res = await mp(['interaction', 'wait', '--id', id, '--timeout', '1', '--json'])

    assert.equal(res.status, 0, '人在认真读，不该被当成失败而结束这一轮')
    const payload = JSON.parse(res.stdout)
    assert.equal(payload.status, 'waiting')
    assert.deepEqual(payload.draft.answers, { city: '还在想' })
    assert.match(payload.next, /interaction wait --id/)
  } finally {
    handle.dispose()
  }
})

test('链接过期后 wait 报 expired_link、退出码 0，并指向重开的命令', async () => {
  const { id, handle } = await startDaemon({ formTtlMinutes: 0.02 })
  try {
    const deadline = Date.now() + 5_000
    while (state.readInteraction(id).stage !== 'expired_link' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }

    const res = await mp(['interaction', 'wait', '--id', id, '--json'])
    assert.equal(res.status, 0)
    const payload = JSON.parse(res.stdout)
    assert.equal(payload.status, 'expired_link')
    assert.match(payload.next, /interaction ask --id .* --html/)
  } finally {
    handle.dispose()
  }
})

test('不带 --json 时，答案本身照样是可解析的 JSON——agent 要的是值，不是散文', async () => {
  const { id, handle } = await startDaemon()
  try {
    await submit(id, handle)
    const res = await mp(['interaction', 'wait', '--id', id])

    assert.equal(res.status, 0)
    assert.match(res.stdout, new RegExp(`${id} answered`))
    const body = res.stdout.slice(res.stdout.indexOf('{'))
    assert.deepEqual(JSON.parse(body), { city: 'sz' })
  } finally {
    handle.dispose()
  }
})

test('wait 找不到记录时才失败，并说清是关掉了还是过期了', async () => {
  const res = await mp(['interaction', 'wait', '--id', 'i-ffffff'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /is gone|no open interaction/)
})

test('同时开着两个时不许瞎猜，要求 --id', async () => {
  const a = await startDaemon()
  const b = await startDaemon()
  try {
    const res = await mp(['interaction', 'wait'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /several interactions are open/)
    assert.match(res.stderr, new RegExp(a.id))
    assert.match(res.stderr, new RegExp(b.id))
  } finally {
    a.handle.dispose()
    b.handle.dispose()
  }
})

test('status 列出开着的问题与草稿进度；close 之后就没了', async () => {
  const { id, handle } = await startDaemon()
  try {
    const listed = JSON.parse((await mp(['interaction', 'status', '--json'])).stdout)
    const mine = listed.find((s) => s.id === id)
    assert.ok(mine)
    assert.equal(mine.stage, 'collecting')
    assert.match(mine.url, /^https:\/\/fake-.*__mp_token=/)

    const closed = await mp(['interaction', 'close', '--id', id])
    assert.equal(closed.status, 0, closed.stderr)
    assert.equal(state.readInteraction(id), null)
  } finally {
    handle.dispose()
  }
})

test('ask --id 换一版页面：revision 加一，链接是新的', async () => {
  const { id, handle } = await startDaemon()
  try {
    await submit(id, handle, { disposition: 'needs_clarification', answers: {}, reason: 'premise' })

    const next = pageFile('v2.html', PAGE.replace('先做哪件', '换个问法'))
    const res = await mp(['interaction', 'ask', '--id', id, '--html', next, '--json'])

    assert.equal(res.status, 0, res.stderr)
    const payload = JSON.parse(res.stdout)
    assert.equal(payload.revision, 2)
    assert.equal(payload.reopen, true)
    assert.match(payload.url, /__mp_token=/)
    assert.equal(state.readInteraction(id).history.length, 1)
  } finally {
    handle.dispose()
  }
})

test('链接在裸行上单独一行，手机上才复制得动', () => {
  const s = {
    id: 'i-abc123',
    tunnelUrl: 'https://x.trycloudflare.com',
    sessionToken: 'tok',
    formExpiresAt: Date.now() + 30 * 60_000,
    expiresAt: Date.now() + 120 * 60_000,
    revision: 1,
  }
  const url = interactionUrl(s)
  const lines = formatInteractionWait(s, { status: 'waiting', draft: null }).split('\n')
  assert.ok(lines.every((l) => l !== url || l.trim() === url))
  assert.match(url, /__mp_token=tok$/)
})

test('本机链接：同一把钥匙直连 127.0.0.1，不经隧道；端口没起来就不给', () => {
  // 2026-09-23：人就坐在电脑前，agent 为了自己看页面起了个静态服务器，
  // 人在预览窗格里点提交——那一份没有桥接脚本，按钮全是死的。
  const s = {
    id: 'i-abc123',
    tunnelUrl: 'https://x.trycloudflare.com',
    sessionToken: 'tok',
    formPort: 54321,
    formExpiresAt: Date.now() + 30 * 60_000,
    expiresAt: Date.now() + 120 * 60_000,
    revision: 1,
  }
  const local = localInteractionUrl(s)
  assert.equal(local, 'http://127.0.0.1:54321/?__mp_token=tok')
  const lines = formatInteractionAsk(s).split('\n')
  // 手机链接仍排第一，本机那条单独成行、能复制。
  assert.equal(lines[1], interactionUrl(s))
  assert.ok(lines.includes(local))
  assert.equal(localInteractionUrl({ ...s, formPort: null }), null)
  assert.ok(!formatInteractionAsk({ ...s, formPort: null }).includes('127.0.0.1'))
})

test('status 的散文形态在没有问题时也说得出话', () => {
  assert.equal(formatInteractionStatus([]), 'no open interaction')
})

// —— 0.5.1 评审修复 ——

test('daemon 没了但答案没人读过：status 看得见，不带 --id 的 wait 也找得到', async () => {
  // 机器重启、进程被杀——记录特意留着，但之前只有手里攥着 id 的人够得着。
  const id = mintInteractionId()
  state.writeInteraction(id, {
    id,
    purpose: '重启前答完的那个问题',
    daemonPid: 999_999_999,
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60 * 60_000,
    revision: 1,
    stage: 'submitted',
    response: {
      receiptId: 'rc-1',
      responseId: 'resp-1',
      disposition: 'answered',
      answers: { city: 'sz' },
      reason: null,
      revision: 1,
      receivedAt: Date.now() - 30_000,
    },
  })
  try {
    const listed = JSON.parse((await mp(['interaction', 'status', '--json'])).stdout)
    const mine = listed.find((s) => s.id === id)
    assert.ok(mine, 'status 不说，等于这份答案不存在')
    assert.equal(mine.daemonGone, true)
    assert.equal(mine.disposition, 'answered')

    const prose = await mp(['interaction', 'status'])
    assert.ok(prose.stdout.includes(id) && prose.stdout.includes('nobody has read it'), prose.stdout)

    const read = await mp(['interaction', 'wait', '--json'])
    assert.equal(read.status, 0, read.stderr)
    assert.deepEqual(JSON.parse(read.stdout).answers, { city: 'sz' })
  } finally {
    state.clearInteraction(id)
  }
})
