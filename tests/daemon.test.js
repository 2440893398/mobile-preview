import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-daemon-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const { cleanupStale, previewHealth } = await import('../src/daemon.js')

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

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
