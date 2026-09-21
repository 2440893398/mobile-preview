import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 真 daemon 跑在测试进程里（隧道是假的），CLI 作为子进程通过命名管道/socket 找它：
// wait / run / status / forget 走的就是用户走的那条路。CLI 必须异步启动——
// spawnSync 会把测试进程的事件循环卡住，而 daemon 就在这个事件循环上答话。

const dir = mkdtempSync(join(tmpdir(), 'mp-secret-cli-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const { mintSecretId, runSecretDaemon } = await import('../src/secret-daemon.js')
const { BROWSER_ENCRYPT_JS } = await import('../src/secret-crypto.js')
const {
  formatSecretAsk, formatSecretStatus, formatSecretWait, parseFieldSpec,
} = await import('../src/secret-cli.js')

const BIN = fileURLToPath(new URL('../src/bin.js', import.meta.url))
const mpEncrypt = new Function(`${BROWSER_ENCRYPT_JS}; return mpEncrypt`)()
const NODE = process.execPath
const SECRET = 'LTAI5t9f3c1e0b2a-secret'
const ECHO_USE = `"${NODE}" -e "process.stdout.write('k='+process.env.OSS_KEY+' b='+process.env.BUCKET)"`

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
    ? `\\\\.\\pipe\\mp-clitest-${process.pid}-${ipcCounter}-${id}`
    : join(dir, `${id}-${ipcCounter}.sock`)
}

// daemon 跑在测试进程里，放着不管它记下的 daemonPid 就是测试进程自己。而
// `forget` 等 daemon 清记录只等一秒，等不到就 taskkill /T /F 那个 pid——全套
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
  const id = mintSecretId()
  const holder = standIn()
  const handle = await runSecretDaemon({
    ownerPid: holder.pid,
    id,
    purpose: '配置 OSS 上传',
    fields: [{ name: 'OSS_KEY', kind: 'secret' }, { name: 'BUCKET', kind: 'text' }],
    uses: [ECHO_USE],
    ttlMinutes: 60,
    formTtlMinutes: 5,
    closeDelayMs: 10,
    ipcPath: ipcPathFor(id),
    startTunnelFn: async () => ({ url: `https://fake-${id}.trycloudflare.com`, pid: 999_990 }),
    exitFn: () => {},
    ...overrides,
  })
  return { id, handle }
}

async function fill(id, handle, uses = [ECHO_USE]) {
  const s = state.readSecret(id)
  const base = `http://127.0.0.1:${handle.formPort()}`
  const ex = await fetch(`${base}/?__mp_token=${s.sessionToken}`, { redirect: 'manual' })
  const cookie = ex.headers.get('set-cookie').split(';')[0]
  const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text()
  const serverKey = JSON.parse(/var MP=(\{.*?\});/.exec(html)[1]).serverKey
  const payload = await mpEncrypt(serverKey, { OSS_KEY: SECRET, BUCKET: 'my-bucket' })
  const res = await fetch(`${base}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ...payload, uses }),
  })
  assert.equal(res.status, 200)
  await new Promise((r) => setTimeout(r, 60))
}

test('secret ask 的参数校验：缺 purpose、缺 field、坏 field、重复 field、坏 ttl', async () => {
  assert.match((await mp(['secret', 'ask', '--field', 'A'])).stderr, /--purpose is required/)
  assert.match((await mp(['secret', 'ask', '--purpose', 'p'])).stderr, /at least one --field/)
  assert.match((await mp(['secret', 'ask', '--purpose', 'p', '--field', 'bad name'])).stderr, /bad --field name/)
  assert.match((await mp(['secret', 'ask', '--purpose', 'p', '--field', 'A:blob'])).stderr, /bad --field kind/)
  assert.match((await mp(['secret', 'ask', '--purpose', 'p', '--field', 'A', '--field', 'A'])).stderr, /given twice/)
  assert.match((await mp(['secret', 'ask', '--purpose', 'p', '--field', 'A', '--ttl', '0'])).stderr, /--ttl must be between 1 and 1440/)
  assert.match((await mp(['secret', 'ask', '--purpose', 'p', '--field', 'A', '--form-ttl', '99'])).stderr, /--form-ttl must be between 1 and 60/)
  assert.match((await mp(['secret', 'ask', '--id', 'nope', '--use', 'x'])).stderr, /bad --id/)
  assert.match((await mp(['secret', 'ask', '--id', 's-abc123', '--use', 'x'])).stderr, /no active secret slot s-abc123/)
})

test('parseFieldSpec 默认 secret，接受 text 与 multiline', () => {
  assert.deepEqual(parseFieldSpec('OSS_KEY'), { name: 'OSS_KEY', kind: 'secret' })
  assert.deepEqual(parseFieldSpec('BUCKET:text'), { name: 'BUCKET', kind: 'text' })
  assert.deepEqual(parseFieldSpec('PEM:multiline'), { name: 'PEM', kind: 'multiline' })
  assert.match(parseFieldSpec('1BAD').error, /bad --field name/)
})

test('secret run 没有 -- 就拒绝；-- 之后的 --help 不会被当成我们的参数', async () => {
  const res = await mp(['secret', 'run', '--id', 's-abc123'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /give the command after --/)

  const help = await mp(['secret', 'run', '--id', 's-abc123', '--', 'node', '--help'])
  assert.doesNotMatch(help.stdout, /usage: mp secret run/, '-- 之后的 --help 属于被运行的命令')
})

test('没有活槽位时 wait / run 报错，forget 视为成功，status 说 no active', async () => {
  assert.match((await mp(['secret', 'wait'])).stderr, /no active secret slot/)
  assert.match((await mp(['secret', 'run', '--', 'x'])).stderr, /no active secret slot/)
  const f = await mp(['secret', 'forget'])
  assert.equal(f.status, 0)
  assert.match(f.stdout, /forgot 0 active/)
  assert.match((await mp(['secret', 'status'])).stdout, /no active secret slot/)
})

test('端到端：status 显示链接 → 手机填表 → wait 报指纹 → run 注入且脱敏 → forget 清空', async () => {
  const { id, handle } = await startDaemon()
  try {
    const st = await mp(['secret', 'status'])
    assert.equal(st.status, 0, st.stderr)
    assert.match(st.stdout, new RegExp(`${id} — 配置 OSS 上传`))
    assert.match(st.stdout, new RegExp(`^https://fake-${id}\\.trycloudflare\\.com/\\?__mp_token=[A-Za-z0-9_-]{43}$`, 'm'),
      '链接必须是裸行')

    const stJson = JSON.parse((await mp(['secret', 'status', '--json'])).stdout)
    assert.equal(stJson[0].id, id)
    assert.equal(stJson[0].stage, 'collecting')

    const early = await mp(['secret', 'wait', '--timeout', '1'])
    assert.equal(early.status, 1)
    assert.match(early.stderr, /still waiting for the phone/)

    await fill(id, handle)

    const w = await mp(['secret', 'wait'])
    assert.equal(w.status, 0, w.stderr)
    assert.match(w.stdout, new RegExp(`received ${id}: OSS_KEY \\(${SECRET.length} chars, sha256 [0-9a-f]{8}\\), BUCKET`))
    assert.match(w.stdout, /approved uses:/)
    assert.ok(!w.stdout.includes(SECRET))

    const wJson = JSON.parse((await mp(['secret', 'wait', '--json'])).stdout)
    assert.equal(wJson.status, 'filled')
    assert.deepEqual(wJson.uses, [ECHO_USE])
    assert.ok(!JSON.stringify(wJson).includes(SECRET))

    const argv = [NODE, '-e', "process.stdout.write('k='+process.env.OSS_KEY+' b='+process.env.BUCKET)"]
    const r = await mp(['secret', 'run', '--', ...argv])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'k=[REDACTED:OSS_KEY] b=my-bucket')

    const denied = await mp(['secret', 'run', '--', NODE, '-e', 'process.exit(0)'])
    assert.equal(denied.status, 1)
    assert.match(denied.stderr, /not among the uses approved/)

    const after = await mp(['secret', 'status'])
    assert.match(after.stdout, /filled/)
    assert.match(after.stdout, /runs: 1/)
    assert.ok(!after.stdout.includes(SECRET))
    assert.ok(!readFileSync(state.secretStatePath(id), 'utf8').includes(SECRET))

    const fg = await mp(['secret', 'forget'])
    assert.equal(fg.status, 0, fg.stderr)
    assert.match(fg.stdout, new RegExp(`forgot ${id}`))
    assert.equal(state.readSecret(id), null)
  } finally {
    handle.dispose()
  }
})

test('run 透传子进程退出码，stderr 也脱敏', async () => {
  const use = `"${NODE}" -e "process.stderr.write(process.env.OSS_KEY); process.exit(7)"`
  const { id, handle } = await startDaemon({ uses: [use] })
  try {
    await fill(id, handle, [use])
    const r = await mp(['secret', 'run', '--id', id, '--', NODE, '-e', 'process.stderr.write(process.env.OSS_KEY); process.exit(7)'])
    assert.equal(r.status, 7)
    assert.equal(r.stderr.trim(), '[REDACTED:OSS_KEY]')
  } finally {
    handle.dispose()
  }
})

test('两个活槽位时 wait / run / forget 不猜，要求 --id', async () => {
  const a = await startDaemon()
  const b = await startDaemon()
  try {
    for (const args of [['secret', 'wait'], ['secret', 'run', '--', 'x'], ['secret', 'forget']]) {
      const res = await mp(args)
      assert.equal(res.status, 1, args.join(' '))
      assert.match(res.stderr, /several secret slots are active/)
      assert.match(res.stderr, new RegExp(a.id))
      assert.match(res.stderr, new RegExp(b.id))
    }
    const fg = await mp(['secret', 'forget', '--id', a.id])
    assert.equal(fg.status, 0, fg.stderr)
    assert.equal(state.readSecret(a.id), null)
    assert.ok(state.readSecret(b.id), '只忘掉点名的那个')
  } finally {
    a.handle.dispose()
    b.handle.dispose()
  }
})

test('ask --id 追加用途：daemon 重开 approve 表单，CLI 打印新链接', async () => {
  const { id, handle } = await startDaemon()
  try {
    await fill(id, handle)
    const res = await mp(['secret', 'ask', '--id', id, '--use', 'node deploy.js', '--json'])
    assert.equal(res.status, 0, res.stderr)
    const out = JSON.parse(res.stdout)
    assert.equal(out.status, 'collecting')
    assert.equal(out.reopen, true)
    assert.deepEqual(out.pendingUses, ['node deploy.js'])
    assert.match(out.url, /__mp_token=/)

    const again = await mp(['secret', 'ask', '--id', id, '--use', 'node deploy.js'])
    assert.equal(again.status, 1)
    assert.match(again.stderr, /already open/)
  } finally {
    handle.dispose()
  }
})

test('wait 读到 daemon 留下的错误记录时报错并清掉它', async () => {
  const id = mintSecretId()
  state.writeSecret(id, {
    id, purpose: 'p', daemonPid: 999_997, expiresAt: Date.now() + 60_000, stage: 'expired',
    error: 'the form link expired after 10 min without a submission.',
  })
  const res = await mp(['secret', 'wait', '--id', id])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /expired after 10 min/)
  assert.equal(state.readSecret(id), null)
})

test('status 清理过期与死掉的槽位', async () => {
  const dead = mintSecretId()
  state.writeSecret(dead, { id: dead, purpose: 'p', daemonPid: 999_996, expiresAt: Date.now() + 60_000, stage: 'filled' })
  // 过期槽位的 pid 也用一个死 pid：status 会 kill 它记录的进程，而这里的
  // "daemon" 若写成测试进程自己，被清理的就是测试进程。
  const expired = mintSecretId()
  state.writeSecret(expired, { id: expired, purpose: 'p', daemonPid: 999_995, expiresAt: Date.now() - 1, stage: 'filled' })

  const res = await mp(['secret', 'status'])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, new RegExp(`${dead}: previous slot is stale`))
  assert.match(res.stdout, new RegExp(`${expired}: previous slot has expired`))
  assert.equal(state.readSecret(dead), null)
  assert.equal(state.readSecret(expired), null)
})

test('formatters 从不打印值，且链接独占一行', () => {
  const s = {
    id: 's-abc123', purpose: 'p', tunnelUrl: 'https://x.trycloudflare.com', sessionToken: 'T'.repeat(43),
    formExpiresAt: Date.now() + 600_000, expiresAt: Date.now() + 7_200_000, stage: 'collecting',
    fields: [{ name: 'K', kind: 'secret', length: 12, sha256_8: 'deadbeef' }], uses: ['npm run deploy'], pendingUses: ['x'],
  }
  assert.match(formatSecretAsk({ s }), /^https:\/\/x\.trycloudflare\.com\/\?__mp_token=T{43}$/m)
  assert.match(formatSecretAsk({ s }), /expires in 10 min/)
  assert.match(formatSecretWait({ ...s, stage: 'filled' }), /K \(12 chars, sha256 deadbeef\)/)
  assert.match(formatSecretWait({ ...s, stage: 'filled' }), /mp secret run --id s-abc123 -- npm run deploy/)
  assert.match(formatSecretWait({ ...s, uses: [] }), /no uses were approved/)
  assert.match(formatSecretStatus([s]), /waiting for the phone/)
  assert.match(formatSecretStatus([{ ...s, stage: 'filled' }]), /"npm run deploy"/)
  assert.equal(formatSecretStatus([]), 'no active secret slot')
})
