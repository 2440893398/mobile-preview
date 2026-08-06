import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-daemon-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const { cleanupAll, cleanupLegacy, cleanupStale, previewHealth } = await import('../src/daemon.js')

test('cleanupStale is a no-op when there is no state', () => {
  state.clear()
  assert.deepEqual(cleanupStale(), { killed: 0 })
})

test('cleanupStale clears state referencing dead pids', () => {
  state.write({ tunnelPid: 999_999, daemonPid: 999_998, tunnelUrl: 'https://x.trycloudflare.com' })
  const r = cleanupStale()
  assert.equal(r.killed, 0, 'dead pids need no killing')
  assert.equal(state.read(), null, 'state must be wiped')
})

test('cleanupStale removes state whose expiry has passed', () => {
  state.write({ expiresAt: Date.now() - 1000, tunnelUrl: 'https://y.trycloudflare.com' })
  cleanupStale()
  assert.equal(state.read(), null)
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

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
