import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 保存、档位、render 在 daemon 里的全流程。真 daemon 跑在测试进程里，隧道是假的，
// 钥匙串是内存桩（只有测试能传进去，环境变量选不到它）。

const dir = mkdtempSync(join(tmpdir(), 'mp-vault-daemon-'))
process.env.MP_STATE_DIR = join(dir, 'state')

const state = await import('../src/state.js')
const { mintSecretId, runSecretDaemon } = await import('../src/secret-daemon.js')
const { secretCall } = await import('../src/secret-client.js')
const { BROWSER_ENCRYPT_JS } = await import('../src/secret-crypto.js')
const { memoryKeystore } = await import('../src/keystore.js')
const {
  createVault, normalizeRoot, projectId, publicView,
} = await import('../src/secret-vault.js')

const mpEncrypt = new Function(`${BROWSER_ENCRYPT_JS}; return mpEncrypt`)()
const NODE = process.execPath
const SECRET = 'LTAI5t9f3c1e0b2a-secret'
const ECHO_USE = `"${NODE}" -e "process.stdout.write('k='+process.env.OSS_KEY+' b='+process.env.BUCKET)"`
const ECHO_ARGV = [NODE, '-e', "process.stdout.write('k='+process.env.OSS_KEY+' b='+process.env.BUCKET)"]
const LEN_USE = `"${NODE}" -e "process.stdout.write('len='+process.env.OSS_KEY.length)"`
const LEN_ARGV = [NODE, '-e', "process.stdout.write('len='+process.env.OSS_KEY.length)"]
const CAT_USE = `"${NODE}" -e "process.stdout.write(require('fs').readFileSync('out.yml','utf8'))"`
const CAT_ARGV = [NODE, '-e', "process.stdout.write(require('fs').readFileSync('out.yml','utf8'))"]
const KS = memoryKeystore()

let n = 0
function freshProject() {
  n += 1
  const p = join(dir, `proj-${n}`)
  mkdirSync(p, { recursive: true })
  return normalizeRoot(p)
}

let ipcCounter = 0
function ipcPathFor(id) {
  ipcCounter += 1
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mp-vtest-${process.pid}-${ipcCounter}-${id}`
    : join(dir, `${id}-${ipcCounter}.sock`)
}

async function startDaemon(overrides) {
  const id = mintSecretId()
  const tunnels = { count: 0 }
  const handle = await runSecretDaemon({
    id,
    purpose: '配置 OSS 上传',
    fields: [{ name: 'OSS_KEY', kind: 'secret' }, { name: 'BUCKET', kind: 'text' }],
    uses: [ECHO_USE],
    ttlMinutes: 60,
    formTtlMinutes: 5,
    closeDelayMs: 10,
    ipcPath: ipcPathFor(id),
    vault: createVault({ keystore: KS }),
    startTunnelFn: async () => {
      tunnels.count += 1
      return { url: `https://fake-${id}.trycloudflare.com`, pid: 999_990 }
    },
    exitFn: () => {},
    ...overrides,
  })
  return { id, handle, tunnels }
}

async function openPage(id, handle) {
  const s = state.readSecret(id)
  const base = `http://127.0.0.1:${handle.formPort()}`
  const ex = await fetch(`${base}/?__mp_token=${s.sessionToken}`, { redirect: 'manual' })
  assert.equal(ex.status, 302)
  const cookie = ex.headers.get('set-cookie').split(';')[0]
  const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text()
  const mp = JSON.parse(/var MP=(\{.*?\});/.exec(html)[1])
  return { base, cookie, html, mp }
}

async function submit(page, {
  uses = [], files = [], keep = [], save = null, values = {}, passphrase = null,
}) {
  const fields = { ...values }
  if (passphrase !== null) fields.__mp_passphrase = passphrase
  const enc = Object.keys(fields).length ? await mpEncrypt(page.mp.serverKey, fields) : {}
  return fetch(`${page.base}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: page.cookie },
    body: JSON.stringify({
      ...enc, uses, files, keep, save,
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

async function run(handle, argv, extra = {}) {
  let out = ''
  const r = await secretCall(handle.ipcPath, { op: 'run', argv, ...extra }, {
    onEvent: (ev) => { if (ev.type === 'stdout' || ev.type === 'stderr') out += ev.data },
  })
  return { r, out }
}

const VALUES = { OSS_KEY: SECRET, BUCKET: 'my-bucket' }

// Fills a fresh project's form and saves at `level`; returns the project.
async function saveOnce({ level = 'auto', passphrase = null, uses = [ECHO_USE] } = {}) {
  const projectRoot = freshProject()
  const { id, handle } = await startDaemon({ projectRoot, uses })
  try {
    const page = await openPage(id, handle)
    assert.match(page.html, /在这台电脑上记住/)
    const res = await submit(page, {
      uses, values: VALUES, save: { level, days: 90 }, passphrase,
    })
    assert.equal(res.status, 200, await res.text())
    const s = state.readSecret(id)
    assert.equal(s.stage, 'filled')
    assert.deepEqual(s.savedAs, { level, days: 90 })
    assert.ok(!readFileSync(state.secretStatePath(id), 'utf8').includes(SECRET), '状态文件里绝不能有值')
  } finally {
    handle.dispose()
  }
  return projectRoot
}

test('填写并保存（直接用）：vault 里只有密文；下一次 ask 不开隧道、直接 filled，run 照常脱敏', async () => {
  const projectRoot = await saveOnce()
  const vaultText = readFileSync(state.vaultProjectPath(projectId(projectRoot)), 'utf8')
  assert.ok(!vaultText.includes(SECRET))
  assert.equal(publicView(projectRoot).fields.OSS_KEY.level, 'auto')

  const { id, handle, tunnels } = await startDaemon({ projectRoot })
  try {
    assert.equal(tunnels.count, 0, '直接用这一档不应该开隧道')
    const s = state.readSecret(id)
    assert.equal(s.stage, 'filled')
    assert.equal(s.source, 'saved')
    assert.deepEqual(s.uses, [ECHO_USE], '记住的用途直接生效')
    const { r, out } = await run(handle, ECHO_ARGV)
    assert.equal(r.type, 'exit')
    assert.equal(out, 'k=[REDACTED:OSS_KEY] b=my-bucket')
  } finally {
    handle.dispose()
  }
})

test('直接用 + 新用途：只为新用途开批准页，值不重填；批准后记住，再下一次连批准页都不用', async () => {
  const projectRoot = await saveOnce()

  const first = await startDaemon({ projectRoot, uses: [ECHO_USE, LEN_USE] })
  try {
    const s = state.readSecret(first.id)
    assert.equal(s.formMode, 'approve')
    assert.deepEqual(s.pendingUses, [LEN_USE], '只列没批准过的那一条')
    assert.equal(s.source, 'saved')
    const page = await openPage(first.id, first.handle)
    assert.doesNotMatch(page.html, /type="password"/)
    const res = await submit(page, { uses: [LEN_USE] })
    assert.equal(res.status, 200, await res.text())
    await until(() => state.readSecret(first.id).stage === 'filled')
    const { out } = await run(first.handle, LEN_ARGV)
    assert.equal(out, `len=${SECRET.length}`)
  } finally {
    first.handle.dispose()
  }

  const second = await startDaemon({ projectRoot, uses: [ECHO_USE, LEN_USE] })
  try {
    assert.equal(second.tunnels.count, 0)
    assert.deepEqual(state.readSecret(second.id).uses.sort(), [ECHO_USE, LEN_USE].sort())
  } finally {
    second.handle.dispose()
  }
})

test('点一下：下一次开确认页，只点「使用已保存的值」就 filled', async () => {
  const projectRoot = await saveOnce({ level: 'confirm' })
  const { id, handle } = await startDaemon({ projectRoot })
  try {
    const s = state.readSecret(id)
    assert.equal(s.formMode, 'confirm')
    assert.equal(s.formLevel, 'confirm')
    const page = await openPage(id, handle)
    assert.match(page.html, /使用已保存的凭证/)
    assert.match(page.html, /重新填写/)
    const res = await submit(page, { uses: [ECHO_USE], keep: ['OSS_KEY', 'BUCKET'] })
    assert.equal(res.status, 200, await res.text())
    await until(() => state.readSecret(id).stage === 'filled')
    assert.equal(state.readSecret(id).source, 'saved')
    const { out } = await run(handle, ECHO_ARGV)
    assert.equal(out, 'k=[REDACTED:OSS_KEY] b=my-bucket')
  } finally {
    handle.dispose()
  }
})

test('主密码：错的返回 400 可重试，对的 filled；连错 5 次链接失效', async () => {
  const projectRoot = await saveOnce({ level: 'passphrase', passphrase: 'correct horse battery' })

  const a = await startDaemon({ projectRoot })
  try {
    const st = state.readSecret(a.id)
    assert.equal(st.formLevel, 'passphrase')
    const { formatSecretAsk } = await import('../src/secret-cli.js')
    assert.match(formatSecretAsk({ s: st }), /enters their passphrase/, 'CLI 要告诉 AI 这一页要的是主密码，不是点一下')
    const page = await openPage(a.id, a.handle)
    assert.match(page.html, /主密码/)
    const wrong = await submit(page, { uses: [ECHO_USE], keep: ['OSS_KEY', 'BUCKET'], passphrase: 'wrong horse battery' })
    assert.equal(wrong.status, 400)
    assert.match((await wrong.json()).error, /主密码不对（还能再试 4 次）/)
    const right = await submit(page, { uses: [ECHO_USE], keep: ['OSS_KEY', 'BUCKET'], passphrase: 'correct horse battery' })
    assert.equal(right.status, 200, await right.text())
    await until(() => state.readSecret(a.id).stage === 'filled')
    assert.equal((await run(a.handle, ECHO_ARGV)).out, 'k=[REDACTED:OSS_KEY] b=my-bucket')
  } finally {
    a.handle.dispose()
  }

  const b = await startDaemon({ projectRoot })
  try {
    const page = await openPage(b.id, b.handle)
    let last
    for (let i = 0; i < 5; i += 1) {
      last = await submit(page, { uses: [], keep: ['OSS_KEY', 'BUCKET'], passphrase: `nope nope nope ${i}` })
      assert.equal(last.status, 400)
    }
    assert.match((await last.json()).error, /5 次/)
    const after = await submit(page, { uses: [], keep: ['OSS_KEY', 'BUCKET'], passphrase: 'correct horse battery' })
    assert.equal(after.status, 404, '锁定之后连对的主密码也进不来')
    // 只关表单会把 stage 退回 starting，`mp secret wait` 就对着一个没有链接的
    // 槽位一直等到 TTL。锁定必须像表单过期一样写下错误。
    await until(() => state.readSecret(b.id)?.stage === 'locked')
    const s = state.readSecret(b.id)
    assert.equal(s.errorReason, 'passphrase-lockout')
    assert.match(s.error, /mp secret ask/)
  } finally {
    b.handle.dispose()
  }
})

test('重新填写且不再保存：旧的保存记录被删掉', async () => {
  const projectRoot = await saveOnce({ level: 'confirm' })
  const { id, handle } = await startDaemon({ projectRoot })
  try {
    const page = await openPage(id, handle)
    const res = await submit(page, { uses: [ECHO_USE], values: { OSS_KEY: 'NEW-VALUE-123456', BUCKET: 'b2' } })
    assert.equal(res.status, 200, await res.text())
    await until(() => state.readSecret(id).stage === 'filled')
    assert.equal(publicView(projectRoot).exists, false)
    assert.equal((await run(handle, ECHO_ARGV)).out, 'k=[REDACTED:OSS_KEY] b=b2')
  } finally {
    handle.dispose()
  }
})

test('有人把档位从「点一下」改成「直接用」：解不开，回到填写页，不会被悄悄放行', async () => {
  const projectRoot = await saveOnce({ level: 'confirm' })
  state.writeVaultProject(projectId(projectRoot), (cur) => ({
    fields: Object.fromEntries(Object.entries(cur.fields).map(([k, v]) => [k, { ...v, level: 'auto' }])),
  }))
  const { id, handle, tunnels } = await startDaemon({ projectRoot })
  try {
    assert.equal(tunnels.count, 1, '必须走手机')
    assert.equal(state.readSecret(id).formMode, 'fill')
    const page = await openPage(id, handle)
    assert.match(page.html, /type="password"/)
  } finally {
    handle.dispose()
  }
})

test('没有可用的钥匙串：页面没有保存选项；硬塞 save 被拒', async () => {
  const projectRoot = freshProject()
  const { id, handle } = await startDaemon({
    projectRoot, vault: createVault({ keystore: memoryKeystore({ available: false }) }),
  })
  try {
    const page = await openPage(id, handle)
    assert.doesNotMatch(page.html, /在这台电脑上记住/)
    assert.match(page.html, /不能保存/)
    const res = await submit(page, { uses: [], values: VALUES, save: { level: 'auto', days: 90 } })
    assert.equal(res.status, 400)
  } finally {
    handle.dispose()
  }
})

test('render：批准后 run --render 写出真文件给命令用，命令一结束就删；输出照样打码', async () => {
  const projectRoot = freshProject()
  const tpl = join(projectRoot, 'out.yml.tpl')
  const out = join(projectRoot, 'out.yml')
  writeFileSync(tpl, 'key: {{mp:OSS_KEY|json}}\nbucket: {{mp:BUCKET}}\n')
  const { id, handle } = await startDaemon({
    projectRoot, uses: [CAT_USE], renders: [{ template: tpl, out, keep: false }],
  })
  try {
    const page = await openPage(id, handle)
    assert.match(page.html, /写入配置文件 · 用完即删/)
    assert.match(page.html, />out\.yml</, '项目内的文件显示相对路径')
    const res = await submit(page, { uses: [CAT_USE], files: page.mp.files, values: VALUES })
    assert.equal(res.status, 200, await res.text())
    await until(() => state.readSecret(id).stage === 'filled')

    const denied = await run(handle, CAT_ARGV, { cwd: projectRoot, renders: [{ template: tpl, out: join(projectRoot, 'other.yml') }] })
    assert.equal(denied.r.code, 'not-approved')

    const { r, out: printed } = await run(handle, CAT_ARGV, { cwd: projectRoot, renders: [{ template: tpl, out }] })
    assert.equal(r.type, 'exit')
    assert.equal(r.code, 0)
    assert.equal(printed, 'key: "[REDACTED:OSS_KEY]"\nbucket: my-bucket\n')
    assert.ok(!existsSync(out), '命令结束后文件必须消失')
    assert.deepEqual(state.readSecret(id).renderedFiles, [])
  } finally {
    handle.dispose()
  }
})

test('render 不覆盖手写的文件；peek 给打码视图；slot 结束时删掉 slot 期的文件', async () => {
  const projectRoot = freshProject()
  const tpl = join(projectRoot, 'out.yml.tpl')
  const out = join(projectRoot, 'out.yml')
  writeFileSync(tpl, 'key: {{mp:OSS_KEY}}\n')
  writeFileSync(out, 'hand written\n')
  const { id, handle } = await startDaemon({
    projectRoot, uses: [], renders: [{ template: tpl, out, keep: false }],
  })
  try {
    const page = await openPage(id, handle)
    assert.equal((await submit(page, { uses: [], files: page.mp.files, values: VALUES })).status, 200)
    await until(() => state.readSecret(id).stage === 'filled')

    const clobber = await secretCall(handle.ipcPath, { op: 'render', renders: [{ template: tpl, out }] })
    assert.equal(clobber.type, 'error')
    assert.match(clobber.error, /not written by mp/)
    assert.equal(readFileSync(out, 'utf8'), 'hand written\n')

    // 挪走手写的文件，再渲染
    writeFileSync(out, '')
    const { rmSync } = await import('node:fs')
    rmSync(out)
    const ok = await secretCall(handle.ipcPath, { op: 'render', renders: [{ template: tpl, out }] })
    assert.equal(ok.type, 'ok', JSON.stringify(ok))
    assert.equal(ok.rendered[0].lifetime, 'slot')
    assert.equal(readFileSync(out, 'utf8'), `key: ${SECRET}\n`)

    const peek = await secretCall(handle.ipcPath, { op: 'peek', path: out })
    assert.equal(peek.content, 'key: [REDACTED:OSS_KEY]\n')
    const notOurs = await secretCall(handle.ipcPath, { op: 'peek', path: tpl })
    assert.equal(notOurs.code, 'not-rendered')
  } finally {
    handle.dispose()
  }
  assert.ok(!existsSync(out), 'slot 结束时删掉')
})
