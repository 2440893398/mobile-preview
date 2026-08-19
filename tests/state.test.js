import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const dir = mkdtempSync(join(tmpdir(), 'mp-state-'))
process.env.MP_STATE_DIR = dir

const {
  read, readState, write, clear, list,
  statePath, tunnelLogPath, galleryDir, previewsDir, legacyStatePath,
} = await import('../src/state.js')

const STATE_MODULE_URL = new URL('../src/state.js', import.meta.url).href

test('每条预览的状态文件以端口命名，放在 previews 目录下', () => {
  assert.equal(previewsDir(), join(dir, 'previews'))
  assert.equal(statePath(4321), join(dir, 'previews', '4321.json'))
})

test('隧道日志与状态文件同目录，按端口区分', () => {
  assert.equal(tunnelLogPath(4321), join(dir, 'previews', '4321.cloudflared.log'))
})

test('产物目录按端口分开', () => {
  assert.equal(galleryDir(4321), join(dir, 'gallery', '4321'))
  assert.notEqual(galleryDir(4321), galleryDir(3000))
})

test('遗留的单槽状态文件仍在根目录', () => {
  assert.equal(legacyStatePath(), join(dir, 'state.json'))
})

test('没有状态文件时 read 返回 null', () => {
  assert.equal(read(4321), null)
})

test('write 后 read 能读回', () => {
  write(4321, { tunnelUrl: 'https://a.trycloudflare.com', ttl: 30 })
  assert.equal(read(4321).tunnelUrl, 'https://a.trycloudflare.com')
  assert.equal(read(4321).ttl, 30)
})

test('write 是合并而非替换', () => {
  write(4321, { proxyPort: 41234 })
  const s = read(4321)
  assert.equal(s.proxyPort, 41234)
  assert.equal(s.tunnelUrl, 'https://a.trycloudflare.com')
})

test('write 接受函数式补丁：在锁内基于最新状态计算，防止同字段的读改写丢更新', () => {
  const port = 4517
  write(port, { artifacts: ['a.png'] })
  // 模拟"快照过期"：函数式补丁不该依赖调用方手里的旧快照
  write(port, { artifacts: ['a.png', 'b.png'] })
  write(port, (cur) => ({ artifacts: [...cur.artifacts, 'c.png'] }))
  assert.deepEqual(read(port).artifacts, ['a.png', 'b.png', 'c.png'])
  clear(port)
})

test('write 拒绝写到 corrupt 槽上，而不是把它"重生"成只含补丁的新记录', () => {
  const port = 4518
  mkdirSync(previewsDir(), { recursive: true })
  writeFileSync(statePath(port), '{ not json')
  assert.throws(() => write(port, { artifacts: [] }), /corrupt/)
  assert.equal(readState(port).status, 'corrupt', '文件必须原样留给 sweep 处理')
  rmSync(statePath(port), { force: true })
})

test('两个端口的状态互不干扰', () => {
  write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })
  assert.equal(read(4321).tunnelUrl, 'https://a.trycloudflare.com')
  assert.equal(read(3000).tunnelUrl, 'https://b.trycloudflare.com')
})

test('clear 只删指定端口', () => {
  write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })
  clear(3000)
  assert.equal(read(3000), null)
  assert.equal(read(4321).tunnelUrl, 'https://a.trycloudflare.com')
})

test('clear 对不存在的预览是无操作', () => {
  clear(9999)
  assert.equal(read(9999), null)
})

test('list 返回全部预览并按端口升序', () => {
  write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })
  write(8080, { tunnelUrl: 'https://c.trycloudflare.com' })
  const ports = list().map((s) => s.targetPort)
  assert.deepEqual(ports, [3000, 4321, 8080])
})

test('list 给出的 targetPort 是数字，以文件名为准', () => {
  write(3000, { targetPort: 'nonsense' })
  const found = list().find((s) => s.targetPort === 3000)
  assert.equal(typeof found.targetPort, 'number')
})

test('list 跳过损坏的 json 而不抛异常', () => {
  writeFileSync(join(previewsDir(), '7777.json'), '{ not json', 'utf8')
  const ports = list().map((s) => s.targetPort)
  assert.ok(!ports.includes(7777), '损坏条目不应出现在结果里')
  assert.ok(ports.includes(4321), '其余条目仍应返回')
})

test('list 跳过文件名不是纯数字的条目', () => {
  writeFileSync(join(previewsDir(), 'notes.json'), '{"tunnelUrl":"x"}', 'utf8')
  writeFileSync(join(previewsDir(), '4321.cloudflared.log'), 'INF x', 'utf8')
  assert.equal(list().filter((s) => Number.isNaN(s.targetPort)).length, 0)
})

test('previews 目录不存在时 list 返回空数组', () => {
  const empty = mkdtempSync(join(tmpdir(), 'mp-state-empty-'))
  const prev = process.env.MP_STATE_DIR
  process.env.MP_STATE_DIR = empty
  try {
    assert.deepEqual(list(), [])
  } finally {
    process.env.MP_STATE_DIR = prev
    rmSync(empty, { recursive: true, force: true })
  }
})

test('write 是原子的：改名覆盖，而不是就地截断改写（Finding 2）', () => {
  // write runs on every `mp capture`, and a plain writeFileSync interrupted
  // mid-write leaves truncated JSON — which read() reports as null, list()
  // skips, and cleanup therefore never sweeps, orphaning a live cloudflared.
  // The mechanism that rules that out is write-elsewhere-then-rename, and the
  // observable signature of a rename is that the file identity changes: an
  // in-place write keeps the same one. (NTFS bumps the sequence number in the
  // high bits of the file index even when it reuses an MFT record, so a fresh
  // file never reports the identity of the one it replaced.)
  write(6100, { generation: 1 })
  const before = statSync(statePath(6100))

  write(6100, { generation: 2 })
  const after = statSync(statePath(6100))

  assert.notEqual(String(after.ino), String(before.ino), '就地改写会保留同一个文件身份；原子写入必然换掉它')
  assert.equal(read(6100).generation, 2, '合并写入的语义不变')
  assert.deepEqual(
    readdirSync(previewsDir()).filter((n) => n.endsWith('.tmp')),
    [],
    '不得留下临时文件',
  )
  clear(6100)
})

test('read 遇到损坏 json 返回 null 而非抛异常', () => {
  mkdirSync(previewsDir(), { recursive: true })
  writeFileSync(statePath(5555), '{ not json', 'utf8')
  assert.equal(read(5555), null)
})

test('readState 区分「没有文件」与「文件存在但解析不了」（Gap 1）', () => {
  // read() collapses both to null, which is exactly what let `mp start`
  // double-spawn over a truncated slot: it saw null either way and had no
  // way to tell "nothing here, safe to start" from "something here I could
  // not read".
  assert.deepEqual(readState(5556), { status: 'missing', value: null })

  mkdirSync(previewsDir(), { recursive: true })
  writeFileSync(statePath(5556), '{"tunnelPid": 4242, "daemo', 'utf8')
  assert.deepEqual(readState(5556), { status: 'corrupt', value: null })

  // write 拒绝在 corrupt 槽上落笔（否则会把带 pid 的残档静默重生成
  // 只含补丁的新记录）；清掉之后才能正常写。
  assert.throws(() => write(5556, { tunnelUrl: 'https://ok.trycloudflare.com' }), /corrupt/)

  clear(5556)
  write(5556, { tunnelUrl: 'https://ok.trycloudflare.com' })
  const r = readState(5556)
  assert.equal(r.status, 'ok')
  assert.equal(r.value.tunnelUrl, 'https://ok.trycloudflare.com')

  clear(5556)
})

test('write 不留下锁文件：正常路径下锁总会被释放', () => {
  write(6150, { a: 1 })
  const leftover = readdirSync(previewsDir()).filter((n) => n.endsWith('.lock'))
  assert.deepEqual(leftover, [])
  clear(6150)
})

test('并发的 read-modify-write 会丢更新：后写者用着过期快照，把先写者刚落地的字段覆盖掉（旧行为示范，Gap 3）', () => {
  // This is exactly the shape described in the design doc: onWindowOpen and
  // `mp capture` each do state.write(port, patch), and write()'s own merge
  // only protects a caller whose read happens at call time. If a writer's
  // read predates a sibling's rename — real OS scheduling, not a caller
  // mistake — and it renames after that sibling, its stale merge wins
  // outright and the sibling's field is gone. No exception, no torn file:
  // just a fully valid JSON file missing a field that was there a moment
  // ago. This reproduces write()'s own merge formula directly (not through
  // the lock) to show why serializing writers, not just making the rename
  // atomic, is the part that was missing.
  const port = 9199
  write(port, { artifacts: [] })

  const daemonRead = read(port) // "process A" (onWindowOpen) reads first
  const captureRead = read(port) // "process B" (mp capture) reads before A writes

  writeFileSync(statePath(port), JSON.stringify({ ...daemonRead, graceOpenedAt: 555 }, null, 2)) // A writes
  writeFileSync(statePath(port), JSON.stringify({ ...captureRead, artifacts: ['shot-1.png'] }, null, 2)) // B writes from its stale snapshot, second

  const final = read(port)
  assert.equal(final.graceOpenedAt, undefined, 'B 的快照里没有 A 刚写的字段，B 的写入把它连带覆盖掉了')
  assert.deepEqual(final.artifacts, ['shot-1.png'])
  clear(port)
})

test('write() 用文件锁把交叠的写入串行化：谁都不会吃掉对方的字段（Gap 3）', async () => {
  const port = 9200
  write(port, { artifacts: [] })

  // Stand in for onWindowOpen already mid-write: it has read (captured
  // below, used later) and is about to compute+write its own patch, but has
  // not renamed yet — represented by holding the lock write() itself would
  // hold at that point.
  const daemonRead = read(port)
  const lockPath = `${statePath(port)}.lock`
  writeFileSync(lockPath, String(process.pid), { flag: 'wx' })

  // Stand in for `mp capture`: a separate process racing to add an artifact
  // while onWindowOpen's write is still in flight. A fixed write() must
  // block on the lock above rather than read around it.
  const script = `
    process.env.MP_STATE_DIR = ${JSON.stringify(dir)};
    import(${JSON.stringify(STATE_MODULE_URL)})
      .then((state) => { state.write(${port}, { artifacts: ['shot-1.png'] }); })
      .catch((e) => { console.error(e); process.exitCode = 1; });
  `
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
  let childErr = ''
  child.stderr.on('data', (d) => { childErr += d.toString() })
  // Attached immediately, before any await: an unlocked write() can exit
  // within a couple hundred ms (process spawn overhead dominates), and a
  // listener attached after that has already happened would never see the
  // event fire — a false "still waiting" that has nothing to do with the
  // lock.
  const childExit = new Promise((resolve, reject) => {
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`capture child exited ${code}: ${childErr}`))))
  })

  // A generous head start: long enough that an unlocked write() (which does
  // no waiting at all) has certainly already read, merged, and renamed —
  // real writes take microseconds; process spawn overhead dominates this.
  await new Promise((r) => setTimeout(r, 500))

  // onWindowOpen "finishes": merges its own patch onto the read it took at
  // the top, and releases the lock. A fixed capture write(), still blocked
  // on the lock, only reads after this point and so still sees it.
  writeFileSync(statePath(port), JSON.stringify({ ...daemonRead, graceOpenedAt: 555 }, null, 2))
  rmSync(lockPath, { force: true })

  await Promise.race([
    childExit,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('capture write never completed — stuck on the lock?')),
      8_000,
    )),
  ])

  const final = read(port)
  assert.equal(final.graceOpenedAt, 555, 'daemon 的字段不能丢')
  assert.deepEqual(final.artifacts, ['shot-1.png'], 'capture 的字段也不能丢')
  clear(port)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
