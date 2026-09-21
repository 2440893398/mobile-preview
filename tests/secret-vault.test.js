import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-vault-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const { memoryKeystore } = await import('../src/keystore.js')
const {
  PassphraseError, appliesTo, createVault, fieldStatus, fingerprint, normalizeRoot, passphraseProblem,
  projectId, projectRoot, publicView, removeSaved, strictestLevel,
} = await import('../src/secret-vault.js')

const SECRET = 'LTAI5t9f3c1e0b2a-secret'
// One keystore for the whole file: every test shares this state dir, so they
// share its vault key too, the way every process of one user does.
const KS = memoryKeystore()
let rootCounter = 0
const freshRoot = () => {
  rootCounter += 1
  return normalizeRoot(join(dir, `proj-${rootCounter}`))
}

async function saved(root, { level = 'auto', days = 90, passphrase = null, keystore = KS } = {}) {
  const v = createVault({ keystore })
  await v.loadKey({ create: true })
  const Kp = level === 'passphrase' ? await v.unlock(passphrase, { create: true }) : null
  v.save(root, [
    { name: 'OSS_KEY', kind: 'secret', value: SECRET },
    { name: 'BUCKET', kind: 'text', value: 'my-bucket' },
  ], { level, days, Kp })
  return { v, Kp, keystore }
}

test('保存后磁盘上只有密文，公开视图只有名字、指纹与日期', async () => {
  const root = freshRoot()
  await saved(root)
  const text = readFileSync(state.vaultProjectPath(projectId(root)), 'utf8')
  assert.ok(!text.includes(SECRET), 'vault 文件里绝不能有明文')
  assert.ok(!text.includes(Buffer.from(SECRET).toString('base64')), '也不能有 base64 形态')

  const view = publicView(root)
  assert.deepEqual(Object.keys(view.fields).sort(), ['BUCKET', 'OSS_KEY'])
  assert.equal(view.fields.OSS_KEY.sha256_8, fingerprint(SECRET).sha256_8)
  assert.equal(view.fields.OSS_KEY.status, 'saved')
  assert.equal(view.fields.OSS_KEY.iv, undefined)
  assert.equal(view.fields.OSS_KEY.ct, undefined)
})

test('同一把库钥匙能解开；换一个 vault 对象（新进程）也能从钥匙串取回 K 再解开', async () => {
  const root = freshRoot()
  const { keystore } = await saved(root)
  const again = createVault({ keystore })
  assert.ok(await again.loadKey())
  const { values, failed } = again.openFields(root, ['OSS_KEY', 'BUCKET'])
  assert.deepEqual(failed, [])
  assert.deepEqual(values, { OSS_KEY: SECRET, BUCKET: 'my-bucket' })
})

test('改档位或到期时间：字段解不开，按未保存处理，不会被悄悄放松', async () => {
  const root = freshRoot()
  const { v } = await saved(root, { level: 'confirm' })
  const pid = projectId(root)
  state.writeVaultProject(pid, (cur) => ({
    fields: {
      ...cur.fields,
      OSS_KEY: { ...cur.fields.OSS_KEY, level: 'auto' },
      BUCKET: { ...cur.fields.BUCKET, expiresAt: null },
    },
  }))
  const { values, failed } = v.openFields(root, ['OSS_KEY', 'BUCKET'])
  assert.deepEqual(failed.sort(), ['BUCKET', 'OSS_KEY'])
  assert.deepEqual(values, {})
  assert.match(readFileSync(state.vaultAuditPath(), 'utf8'), /"tamper"/)
})

test('记住的用途带 HMAC：原样读回；手改一条就整体作废', async () => {
  const root = freshRoot()
  const { v } = await saved(root)
  const uses = [{ use: 'npm run deploy', fields: ['OSS_KEY', 'BUCKET'] }]
  const files = [{ template: 'a.tpl', out: 'a.yml', keep: false, fields: ['OSS_KEY'] }]
  v.setLists(root, { uses, files })
  assert.deepEqual(v.lists(root), { uses, files, ok: true })

  state.writeVaultProject(projectId(root), (cur) => ({ uses: [...cur.uses, { use: 'curl evil', fields: ['OSS_KEY'] }] }))
  assert.deepEqual(v.lists(root), { uses: [], files: [], ok: false })
})

test('记住的用途只适用于它批准时的字段范围之内', () => {
  const e = { use: 'npm run deploy', fields: ['A', 'B'] }
  assert.ok(appliesTo(e, ['A']))
  assert.ok(appliesTo(e, ['A', 'B']))
  assert.ok(!appliesTo(e, ['A', 'C']), '多出来的字段没被批准给这条命令')
})

test('主密码档：没有主密码解不开；主密码对才解得开；错的抛 PassphraseError', async () => {
  const root = freshRoot()
  const { keystore } = await saved(root, { level: 'passphrase', passphrase: 'correct horse battery' })

  const v = createVault({ keystore })
  await v.loadKey()
  assert.deepEqual(v.openFields(root, ['OSS_KEY']).failed, ['OSS_KEY'], '只有 K 不够')

  await assert.rejects(v.unlock('wrong horse battery'), PassphraseError)
  const Kp = await v.unlock('correct horse battery')
  assert.deepEqual(v.openFields(root, ['OSS_KEY'], { Kp }).values, { OSS_KEY: SECRET })
})

// 用户的决定（2026-09-21）：像支付密码一样，6 位就行，数字也可以。
test('主密码：至少 6 位，纯数字可以', () => {
  assert.match(passphraseProblem('12345'), /6/)
  assert.equal(passphraseProblem('123456'), null)
  assert.equal(passphraseProblem('correct horse battery'), null)
  assert.equal(passphraseProblem('一二三四五六'), null, '按字符数算，不按字节')
  assert.match(passphraseProblem('一二三四五'), /6/)
})

test('钥匙串不可用：不创建库钥匙，不退回明文', async () => {
  const v = createVault({ keystore: memoryKeystore({ available: false }) })
  assert.equal(await v.available(), false)
  // A vault key from an earlier test already exists in this state dir, so
  // check the refusal against an empty one.
  const other = mkdtempSync(join(tmpdir(), 'mp-vault-empty-'))
  const prev = process.env.MP_STATE_DIR
  process.env.MP_STATE_DIR = other
  try {
    await assert.rejects(v.loadKey({ create: true }), /keystore/)
    assert.equal(state.readVaultKeyFile().status, 'missing')
  } finally {
    process.env.MP_STATE_DIR = prev
  }
})

test('过期：到期后状态是 expired；不过期的永远是 saved', () => {
  const now = Date.now()
  assert.equal(fieldStatus({ expiresAt: now - 1 }, now), 'expired')
  assert.equal(fieldStatus({ expiresAt: now + 1 }, now), 'saved')
  assert.equal(fieldStatus({ expiresAt: null }, now), 'saved')
  assert.equal(fieldStatus(undefined, now), 'missing')
})

test('删除不需要钥匙：删掉部分字段；删光且没有保留文件时整份文件消失', async () => {
  const root = freshRoot()
  await saved(root)
  assert.deepEqual(removeSaved(root, ['BUCKET']).removed, ['BUCKET'])
  assert.deepEqual(Object.keys(publicView(root).fields), ['OSS_KEY'])
  assert.deepEqual(removeSaved(root).removed, ['OSS_KEY'])
  assert.equal(publicView(root).exists, false)
})

test('项目识别：git 仓库顶层、大小写与斜杠归一；不在仓库里就用目录本身', () => {
  const repo = join(dir, 'repo-a')
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
  const fakeGit = (cmd, args, { cwd }) => (cwd.startsWith(repo)
    ? { status: 0, stdout: `${repo.replaceAll('\\', '/')}\n` }
    : { status: 128, stdout: '' })
  const a = projectRoot(join(repo, 'src', 'deep'), { spawnSyncFn: fakeGit })
  assert.equal(a, normalizeRoot(repo))
  if (process.platform === 'win32') assert.equal(a, a.toLowerCase())

  const loose = join(dir, 'loose')
  mkdirSync(loose, { recursive: true })
  assert.equal(projectRoot(loose, { spawnSyncFn: fakeGit }), normalizeRoot(loose))
  assert.notEqual(projectId(a), projectId(normalizeRoot(loose)))
})

test('档位取最严', () => {
  assert.equal(strictestLevel(['auto', 'auto']), 'auto')
  assert.equal(strictestLevel(['auto', 'confirm']), 'confirm')
  assert.equal(strictestLevel(['passphrase', 'confirm', 'auto']), 'passphrase')
})

test('vault.key 损坏：明确报错，不当成「没有钥匙」去新建', async () => {
  const other = mkdtempSync(join(tmpdir(), 'mp-vault-corrupt-'))
  const prev = process.env.MP_STATE_DIR
  process.env.MP_STATE_DIR = other
  try {
    mkdirSync(state.vaultDir(), { recursive: true })
    writeFileSync(state.vaultKeyPath(), '{ nope')
    const v = createVault({ keystore: memoryKeystore() })
    await assert.rejects(v.loadKey({ create: true }), /corrupt/)
  } finally {
    process.env.MP_STATE_DIR = prev
  }
})
