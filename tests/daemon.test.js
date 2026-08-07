import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-daemon-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const {
  cleanupAll, cleanupLegacy, cleanupStale, clearOwnedState, previewHealth,
} = await import('../src/daemon.js')

// Two of the three original no-argument tests here ('is a no-op when there
// is no state' and 'removes state whose expiry has passed') were dropped:
// ported to the port(port, patch) signature they duplicated coverage already
// present below ('cleanupStale 对不存在的预览是无操作' for the no-op case;
// 'cleanupStale 只清理指定端口' for the write-then-clear case — cleanupStale
// itself never inspects expiresAt, so the "expiry" test exercised nothing
// that write-then-clear didn't already). This one is kept and ported because
// it is the only test that puts *live-looking-but-actually-dead* pids
// through killRecorded's isAlive() skip path.
test('cleanupStale clears state referencing dead pids', () => {
  state.write(6001, { tunnelPid: 999_999, daemonPid: 999_998, tunnelUrl: 'https://x.trycloudflare.com' })
  const r = cleanupStale(6001)
  assert.equal(r.killed, 0, 'dead pids need no killing')
  assert.equal(state.read(6001), null, 'state must be wiped')
})

test('previewHealth marks future state with dead pids as stale', () => {
  const h = previewHealth({
    tunnelUrl: 'https://dead.trycloudflare.com',
    sessionToken: 's'.repeat(43),
    expiresAt: Date.now() + 60_000,
    tunnelPid: 999_999,
    daemonPid: 999_998,
  })
  assert.equal(h.active, false)
  assert.equal(h.reason, 'stale')
})

test('previewHealth accepts unexpired state only when required pids are alive', () => {
  const h = previewHealth({
    tunnelUrl: 'https://live.trycloudflare.com',
    sessionToken: 's'.repeat(43),
    expiresAt: Date.now() + 60_000,
    tunnelPid: process.pid,
    daemonPid: process.pid,
  })
  assert.equal(h.active, true)
})

test('cleanupStale 只清理指定端口', () => {
  state.write(4321, { tunnelUrl: 'https://a.trycloudflare.com' })
  state.write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })

  const r = cleanupStale(4321)

  assert.equal(r.killed, 0, '没有活着的 pid 时不该杀掉任何东西')
  assert.equal(state.read(4321), null)
  assert.ok(state.read(3000), '别的端口不该被波及')
})

test('cleanupStale 对不存在的预览是无操作', () => {
  assert.deepEqual(cleanupStale(9999), { killed: 0 })
})

test('cleanupAll 清掉全部预览', () => {
  state.write(4321, { tunnelUrl: 'https://a.trycloudflare.com' })
  state.write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })

  cleanupAll()

  assert.deepEqual(state.list(), [])
})

test('cleanupLegacy 删掉旧版遗留的单槽状态文件', () => {
  writeFileSync(state.legacyStatePath(), JSON.stringify({
    tunnelUrl: 'https://legacy.trycloudflare.com',
    tunnelPid: 999_999,
    daemonPid: 999_998,
  }), 'utf8')

  const r = cleanupLegacy()

  assert.equal(r.found, true)
  assert.equal(r.killed, 0, '记录的 pid 早已不存在')
  assert.equal(existsSync(state.legacyStatePath()), false)
})

test('cleanupLegacy 在没有遗留文件时报告 found=false', () => {
  assert.deepEqual(cleanupLegacy(), { killed: 0, found: false })
})

test('cleanupLegacy 面对损坏的遗留文件仍删除它', () => {
  writeFileSync(state.legacyStatePath(), '{ not json', 'utf8')

  const r = cleanupLegacy()

  assert.equal(r.found, true)
  assert.equal(existsSync(state.legacyStatePath()), false)
})

test('cleanupAll 顺带处置遗留文件并报告', () => {
  writeFileSync(state.legacyStatePath(), JSON.stringify({ tunnelUrl: 'x' }), 'utf8')

  const r = cleanupAll()

  assert.equal(r.legacy, true)
  assert.equal(existsSync(state.legacyStatePath()), false)
})

test('cleanupAll 清扫 list() 看不见的损坏状态文件，并如实报告（Finding 2）', () => {
  cleanupAll()
  mkdirSync(state.previewsDir(), { recursive: true })
  const corrupt = join(state.previewsDir(), '6123.json')
  writeFileSync(corrupt, '{"tunnelPid": 4242, "daemo', 'utf8') // 写到一半被打断

  // list() 跳过它，所以按 list() 收网的旧实现永远扫不到这一格，
  // 其 cloudflared 会一直挂着，且下一次 start 还会再起一个 daemon。
  assert.equal(state.list().some((s) => s.targetPort === 6123), false)

  const r = cleanupAll()

  assert.equal(existsSync(corrupt), false, '损坏的槽位必须被清掉')
  assert.deepEqual(r.unreadable, [6123], '读不出 pid 就杀不掉，必须单独报出来，不能算作干净地停掉了')
})

test('cleanupAll 仍然照常清扫读得出的槽位', () => {
  cleanupAll()
  state.write(6124, { tunnelUrl: 'https://a.trycloudflare.com' })
  writeFileSync(join(state.previewsDir(), '6125.json'), 'garbage', 'utf8')

  const r = cleanupAll()

  assert.deepEqual(state.list(), [])
  assert.deepEqual(r.unreadable, [6125])
  assert.equal(existsSync(state.statePath(6124)), false)
})

test('clearOwnedState 只清理仍属于自己的槽位（Finding 3）', () => {
  // 老 daemon 的 TTL 到点时，这一格可能已经被新 daemon 接管了
  //（双起，或两个并发的 mp start --port N）。无条件 clear 会抹掉新 daemon
  // 的记录，把它的隧道变成孤儿——status/stop 从此都找不到它。
  state.write(6200, { daemonPid: 4242, tunnelUrl: 'https://new.trycloudflare.com' })

  assert.equal(clearOwnedState(6200, 999_998), false, '不是自己的槽位，不许动')
  assert.ok(state.read(6200), '新 daemon 的记录必须原样留下')

  assert.equal(clearOwnedState(6200, 4242), true, '是自己的槽位就照常清理')
  assert.equal(state.read(6200), null)
})

test('clearOwnedState 对不存在的槽位是无操作', () => {
  assert.equal(clearOwnedState(6201, 4242), false)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
