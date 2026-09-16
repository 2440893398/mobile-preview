import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-secret-daemon-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const {
  fingerprint, mintSecretId, runSecretDaemon, secretHealth,
} = await import('../src/secret-daemon.js')
const { secretCall } = await import('../src/secret-client.js')
const { BROWSER_ENCRYPT_JS } = await import('../src/secret-crypto.js')

const mpEncrypt = new Function(`${BROWSER_ENCRYPT_JS}; return mpEncrypt`)()

const NODE = process.execPath
const SECRET = 'LTAI5t9f3c1e0b2a-secret'
const ECHO_USE = `"${NODE}" -e "process.stdout.write('k='+process.env.OSS_KEY+' b='+process.env.BUCKET)"`
const ECHO_ARGV = [NODE, '-e', "process.stdout.write('k='+process.env.OSS_KEY+' b='+process.env.BUCKET)"]
const B64_USE = `"${NODE}" -e "process.stdout.write(Buffer.from(process.env.OSS_KEY).toString('base64'))"`
const B64_ARGV = [NODE, '-e', "process.stdout.write(Buffer.from(process.env.OSS_KEY).toString('base64'))"]

let ipcCounter = 0
function ipcPathFor(id) {
  ipcCounter += 1
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mp-test-${process.pid}-${ipcCounter}-${id}`
    : join(dir, `${id}-${ipcCounter}.sock`)
}

async function withDaemon(overrides, fn) {
  const id = overrides.id || mintSecretId()
  const exits = []
  const handle = await runSecretDaemon({
    id,
    purpose: '配置 OSS 上传',
    fields: [{ name: 'OSS_KEY', kind: 'secret' }, { name: 'BUCKET', kind: 'text' }],
    uses: [ECHO_USE],
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

async function fillForm(id, handle, { uses, values = { OSS_KEY: SECRET, BUCKET: 'my-bucket' } }) {
  const s = state.readSecret(id)
  const base = `http://127.0.0.1:${handle.formPort()}`
  const ex = await fetch(`${base}/?__mp_token=${s.sessionToken}`, { redirect: 'manual' })
  assert.equal(ex.status, 302)
  const cookie = ex.headers.get('set-cookie').split(';')[0]

  const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text()
  const serverKey = JSON.parse(/var MP=(\{.*?\});/.exec(html)[1]).serverKey
  const payload = serverKey ? await mpEncrypt(serverKey, values) : {}
  const res = await fetch(`${base}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ...payload, uses }),
  })
  assert.equal(res.status, 200, await res.text())
}

async function until(pred, ms = 3_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('condition not met in time')
}

function rawStateText(id) {
  return readFileSync(state.secretStatePath(id), 'utf8')
}

test('起来之后：槽位 collecting、有链接与令牌、IPC 能查状态、run 被拒（还没填）', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    const s = state.readSecret(id)
    assert.equal(s.stage, 'collecting')
    assert.equal(s.tunnelUrl, `https://fake-${id}.trycloudflare.com`)
    assert.match(s.sessionToken, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(s.daemonPid, process.pid)
    assert.deepEqual(s.pendingUses, [ECHO_USE])
    assert.ok(secretHealth(s).active)

    const st = await secretCall(handle.ipcPath, { op: 'status' })
    assert.equal(st.stage, 'collecting')
    assert.deepEqual(st.fields.map((f) => f.name), ['OSS_KEY', 'BUCKET'])

    const run = await secretCall(handle.ipcPath, { op: 'run', argv: ECHO_ARGV })
    assert.equal(run.type, 'error')
    assert.equal(run.code, 'not-filled')
  })
})

test('手机提交后：值只在内存，状态文件只有指纹，隧道关闭；run 注入环境变量且输出脱敏', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    await fillForm(id, handle, { uses: [ECHO_USE] })

    const s = state.readSecret(id)
    assert.equal(s.stage, 'filled')
    assert.deepEqual(s.uses, [ECHO_USE])
    assert.deepEqual(s.fields[0], { name: 'OSS_KEY', kind: 'secret', ...fingerprint(SECRET) })
    assert.equal(s.sessionToken, null)
    assert.ok(!rawStateText(id).includes(SECRET), '状态文件里绝不能有值')

    await until(() => state.readSecret(id).tunnelUrl === null)
    assert.equal(handle.formPort(), null, '提交后表单服务与隧道都应关闭')

    let out = ''
    const r = await secretCall(handle.ipcPath, { op: 'run', argv: ECHO_ARGV, cwd: dir }, {
      onEvent: (ev) => { if (ev.type === 'stdout') out += ev.data },
    })
    assert.equal(r.type, 'exit')
    assert.equal(r.code, 0)
    assert.equal(out, 'k=[REDACTED:OSS_KEY] b=my-bucket', 'secret 字段脱敏，text 字段原样')
    assert.ok(!rawStateText(id).includes(SECRET))
    assert.equal(state.readSecret(id).runs, 1)

    const log = readFileSync(state.secretLogPath(id), 'utf8')
    assert.match(log, /"event":"filled"/)
    assert.match(log, /"event":"run"/)
    assert.ok(!log.includes(SECRET), '审计日志里也不能有值')
  })
})

test('base64 变形也被脱敏', async () => {
  await withDaemon({ uses: [B64_USE] }, async ({ handle, id }) => {
    await fillForm(id, handle, { uses: [B64_USE] })
    let out = ''
    const r = await secretCall(handle.ipcPath, { op: 'run', argv: B64_ARGV }, {
      onEvent: (ev) => { if (ev.type === 'stdout') out += ev.data },
    })
    assert.equal(r.type, 'exit')
    assert.equal(out, '[REDACTED:OSS_KEY]')
  })
})

// 2026-09-11 真机实测的那一幕，原样固化：用户填了一个 4 字符的值，输出里本体被
// 遮蔽、紧挨着的 base64 却原样打了出来，值当场可还原（设计 §12.1）。
test('短值的 base64 也必须遮蔽：本体与编码形态都不能留在输出里', async () => {
  const script = "process.stdout.write('v='+process.env.OSS_KEY+' b64='+Buffer.from(process.env.OSS_KEY).toString('base64'))"
  const use = `"${NODE}" -e "${script}"`
  const short = 'cest'

  await withDaemon({ uses: [use] }, async ({ handle, id }) => {
    await fillForm(id, handle, { uses: [use], values: { OSS_KEY: short, BUCKET: 'b' } })
    let out = ''
    const r = await secretCall(handle.ipcPath, { op: 'run', argv: [NODE, '-e', script] }, {
      onEvent: (ev) => { if (ev.type === 'stdout') out += ev.data },
    })

    assert.equal(r.type, 'exit')
    assert.equal(out, 'v=[REDACTED:OSS_KEY] b64=[REDACTED:OSS_KEY]')
    assert.ok(!out.includes(Buffer.from(short).toString('base64')), '短值的 base64 曾经原样漏出去过')
  })
})

test('未批准的命令被拒绝并写入审计；用户在手机上没勾的用途同样不算批准', async () => {
  await withDaemon({ uses: [ECHO_USE, B64_USE] }, async ({ handle, id }) => {
    await fillForm(id, handle, { uses: [ECHO_USE] }) // 只勾了一个

    const denied = await secretCall(handle.ipcPath, { op: 'run', argv: B64_ARGV })
    assert.equal(denied.type, 'error')
    assert.equal(denied.code, 'not-approved')
    assert.match(denied.error, /mp secret ask --id/)

    const prefix = await secretCall(handle.ipcPath, { op: 'run', argv: [...ECHO_ARGV, '--extra'] })
    assert.equal(prefix.code, 'not-approved', '多一个参数就不是同一条命令')

    assert.match(readFileSync(state.secretLogPath(id), 'utf8'), /"event":"denied"/)
  })
})

test('协议里没有取值操作：get 之类的请求得到 unknown-op，回应里没有值', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    await fillForm(id, handle, { uses: [ECHO_USE] })
    for (const op of ['get', 'dump', 'values', 'export']) {
      const r = await secretCall(handle.ipcPath, { op, name: 'OSS_KEY' })
      assert.equal(r.type, 'error')
      assert.equal(r.code, 'unknown-op')
      assert.ok(!JSON.stringify(r).includes(SECRET))
    }
    const st = await secretCall(handle.ipcPath, { op: 'status' })
    assert.ok(!JSON.stringify(st).includes(SECRET), 'status 也只有指纹')
    assert.equal(st.fields[0].sha256_8, fingerprint(SECRET).sha256_8)
  })
})

test('reopen：追加用途走 approve 模式的表单，批准后可用，值无需重填', async () => {
  await withDaemon({}, async ({ handle, id }) => {
    await fillForm(id, handle, { uses: [ECHO_USE] })
    await until(() => state.readSecret(id).tunnelUrl === null)

    const ok = await secretCall(handle.ipcPath, { op: 'reopen', uses: [B64_USE] })
    assert.equal(ok.type, 'ok')
    await until(() => state.readSecret(id).stage === 'collecting')
    const s = state.readSecret(id)
    assert.ok(s.tunnelUrl && s.sessionToken)
    assert.deepEqual(s.pendingUses, [B64_USE])

    await fillForm(id, handle, { uses: [B64_USE], values: {} })
    await until(() => state.readSecret(id).stage === 'filled')
    assert.deepEqual(state.readSecret(id).uses, [ECHO_USE, B64_USE])

    let out = ''
    const r = await secretCall(handle.ipcPath, { op: 'run', argv: B64_ARGV }, {
      onEvent: (ev) => { if (ev.type === 'stdout') out += ev.data },
    })
    assert.equal(r.type, 'exit')
    assert.equal(out, '[REDACTED:OSS_KEY]')

    const again = await secretCall(handle.ipcPath, { op: 'reopen', uses: [B64_USE] })
    assert.equal(again.alreadyApproved, true, '已批准的用途不再发链接')
  })
})

test('forget：回应 ok、清掉槽位、退出', async () => {
  await withDaemon({}, async ({ handle, id, exits }) => {
    await fillForm(id, handle, { uses: [ECHO_USE] })
    const r = await secretCall(handle.ipcPath, { op: 'forget' })
    assert.equal(r.type, 'ok')
    await until(() => exits.length > 0)
    assert.deepEqual(exits, [0])
    assert.equal(state.readSecret(id), null)
  })
})

test('表单到期没人填：记录 expired 与错误、退出码 1、槽位留给 wait 去读', async () => {
  await withDaemon({ formTtlMinutes: 0.002 }, async ({ id, exits }) => {
    await until(() => exits.length > 0)
    assert.deepEqual(exits, [1])
    const s = state.readSecret(id)
    assert.equal(s.stage, 'expired')
    assert.match(s.error, /expired/)
    assert.equal(s.tunnelUrl, null)
  })
})

test('隧道起不来：记录错误与日志路径、退出码 1', async () => {
  await withDaemon({
    startTunnelFn: async () => {
      const e = new Error('cloudflared failed after 4 attempts')
      e.reason = 'api-unreachable'
      throw e
    },
  }, async ({ id, exits }) => {
    assert.deepEqual(exits, [1])
    const s = state.readSecret(id)
    assert.equal(s.stage, 'failed')
    assert.match(s.error, /4 attempts/)
    assert.equal(s.errorReason, 'api-unreachable')
    assert.ok(!secretHealth(s).active)
  })
})

test('坏 id 直接拒绝', async () => {
  await assert.rejects(() => runSecretDaemon({ id: '../x', purpose: 'p', fields: [] }), /bad secret id/)
})

test('审计日志与状态文件都在 secrets 目录下', () => {
  assert.equal(state.secretStatePath('s-abc123'), join(dir, 'secrets', 's-abc123.json'))
  assert.equal(state.secretLogPath('s-abc123'), join(dir, 'secrets', 's-abc123.log'))
  assert.ok(existsSync(join(dir, 'secrets')))
})
