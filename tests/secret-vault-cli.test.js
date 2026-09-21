import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 用真的系统钥匙串走一遍 CLI：先在测试进程里填一次表并保存，再让真的
// `mp secret ask` 拉起独立的 daemon 进程——它得自己从钥匙串取回库钥匙才能
// 解开值。「直接用」这一档不开隧道，所以整条链路不需要网络。
// 钥匙串不可用的机器上跳过（无头 Linux 常见），不退回任何桩。

const dir = mkdtempSync(join(tmpdir(), 'mp-vault-cli-'))
process.env.MP_STATE_DIR = join(dir, 'state')

const state = await import('../src/state.js')
const { mintSecretId, runSecretDaemon } = await import('../src/secret-daemon.js')
const { BROWSER_ENCRYPT_JS } = await import('../src/secret-crypto.js')
const { platformKeystore } = await import('../src/keystore.js')
const { createVault, normalizeRoot } = await import('../src/secret-vault.js')

const keystore = platformKeystore()
const available = await keystore.available()

const BIN = fileURLToPath(new URL('../src/bin.js', import.meta.url))
const mpEncrypt = new Function(`${BROWSER_ENCRYPT_JS}; return mpEncrypt`)()
const NODE = process.execPath
const SECRET = 'LTAI5t9f3c1e0b2a-secret'
const CAT_USE = `"${NODE}" -e "process.stdout.write(require('fs').readFileSync('out.yml','utf8'))"`

function mp(args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd, env: { ...process.env, MP_STATE_DIR: process.env.MP_STATE_DIR }, windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function allFilesUnder(root) {
  const out = []
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, name.name)
    if (name.isDirectory()) out.push(...allFilesUnder(p))
    else out.push(p)
  }
  return out
}

test('真钥匙串：保存一次 → 真 CLI 的 ask 直接 filled → run/render/peek/saved → forget --saved', { skip: !available && 'no usable system keystore here' }, async () => {
  const project = join(dir, 'proj')
  mkdirSync(project, { recursive: true })
  const projectRoot = normalizeRoot(project)
  const tpl = join(project, 'out.yml.tpl')
  const out = join(project, 'out.yml')
  writeFileSync(tpl, 'key: {{mp:OSS_KEY|json}}\n')

  // 1. 手机填一次并保存（进程内 daemon，隧道是假的，钥匙串是真的）
  const id0 = mintSecretId()
  const d0 = await runSecretDaemon({
    id: id0,
    purpose: '配置 OSS 上传',
    fields: [{ name: 'OSS_KEY', kind: 'secret' }],
    uses: [CAT_USE],
    renders: [{ template: tpl, out, keep: false }],
    projectRoot,
    vault: createVault({ keystore }),
    closeDelayMs: 10,
    ipcPath: process.platform === 'win32' ? `\\\\.\\pipe\\mp-vcli-${process.pid}` : join(dir, 'd0.sock'),
    startTunnelFn: async () => ({ url: 'https://fake.trycloudflare.com', pid: 999_990 }),
    exitFn: () => {},
  })
  try {
    const s = state.readSecret(id0)
    const base = `http://127.0.0.1:${d0.formPort()}`
    const ex = await fetch(`${base}/?__mp_token=${s.sessionToken}`, { redirect: 'manual' })
    const cookie = ex.headers.get('set-cookie').split(';')[0]
    const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text()
    const page = JSON.parse(/var MP=(\{.*?\});/.exec(html)[1])
    const enc = await mpEncrypt(page.serverKey, { OSS_KEY: SECRET })
    const res = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        ...enc, uses: [CAT_USE], files: page.files, save: { level: 'auto', days: 90 },
      }),
    })
    assert.equal(res.status, 200, await res.text())
  } finally {
    d0.dispose()
  }

  // 2. 真 CLI：同一个项目再要一次，直接 filled，没有链接
  const ask = await mp(['secret', 'ask', '--purpose', '配置 OSS 上传', '--field', 'OSS_KEY', '--use', CAT_USE,
    '--render', 'out.yml.tpl=out.yml', '--json'], { cwd: project })
  assert.equal(ask.status, 0, ask.stderr)
  const filled = JSON.parse(ask.stdout)
  assert.equal(filled.status, 'filled')
  assert.equal(filled.source, 'saved')
  assert.ok(!ask.stdout.includes('trycloudflare'), '直接用不发链接')
  const { id } = filled

  try {
    // 3. run --render：命令读到真文件，输出打码，结束后文件消失
    const run = await mp(['secret', 'run', '--id', id, '--render', 'out.yml.tpl=out.yml', '--',
      NODE, '-e', "process.stdout.write(require('fs').readFileSync('out.yml','utf8'))"], { cwd: project })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, 'key: "[REDACTED:OSS_KEY]"\n')
    assert.ok(!existsSync(out))

    // 4. render + peek：留到 slot 结束；peek 打码
    const rendered = await mp(['secret', 'render', '--id', id, 'out.yml.tpl=out.yml'], { cwd: project })
    assert.equal(rendered.status, 0, rendered.stderr)
    assert.match(rendered.stdout, /wrote .*out\.yml/)
    assert.equal(readFileSync(out, 'utf8'), `key: ${JSON.stringify(SECRET)}\n`)
    const peek = await mp(['secret', 'peek', '--id', id, 'out.yml'], { cwd: project })
    assert.equal(peek.stdout, 'key: "[REDACTED:OSS_KEY]"\n')

    // 5. saved：名字、档位、指纹，没有值
    const saved = await mp(['secret', 'saved'], { cwd: project })
    assert.equal(saved.status, 0, saved.stderr)
    assert.match(saved.stdout, /OSS_KEY — auto/)
    assert.ok(!saved.stdout.includes(SECRET))
  } finally {
    const forget = await mp(['secret', 'forget', '--id', id], { cwd: project })
    assert.equal(forget.status, 0, forget.stderr)
  }
  assert.ok(!existsSync(out), 'forget 之后 slot 期的文件也删掉了')

  // 6. 全盘搜：状态目录里除了密文，任何地方都没有明文或它的常见形态
  const forms = [SECRET, Buffer.from(SECRET).toString('base64'), encodeURIComponent(SECRET)]
  for (const f of allFilesUnder(process.env.MP_STATE_DIR)) {
    const text = readFileSync(f, 'utf8')
    for (const form of forms) assert.ok(!text.includes(form), `${f} 里出现了值的明文形态`)
  }

  // 7. forget --saved：删干净
  const del = await mp(['secret', 'forget', '--saved'], { cwd: project })
  assert.equal(del.status, 0, del.stderr)
  assert.match(del.stdout, /deleted saved values/)
  const after = await mp(['secret', 'saved'], { cwd: project })
  assert.match(after.stdout, /nothing is saved/)
})
