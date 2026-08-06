import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-state-'))
process.env.MP_STATE_DIR = dir

const { read, write, clear, statePath, tunnelLogPath } = await import('../src/state.js')

test('tunnel log lives next to the state file', () => {
  assert.equal(tunnelLogPath(), join(dir, 'cloudflared.log'))
})

test('read returns null when no state file exists', () => {
  assert.equal(read(), null)
})

test('write then read roundtrips', () => {
  write({ tunnelUrl: 'https://a.trycloudflare.com', ttl: 30 })
  assert.equal(read().tunnelUrl, 'https://a.trycloudflare.com')
  assert.equal(read().ttl, 30)
})

test('write merges into existing state rather than replacing', () => {
  write({ proxyPort: 41234 })
  const s = read()
  assert.equal(s.proxyPort, 41234)
  assert.equal(s.tunnelUrl, 'https://a.trycloudflare.com')
})

test('read returns null on corrupt json instead of throwing', () => {
  writeFileSync(statePath(), '{ not json')
  assert.equal(read(), null)
})

test('clear removes the state file', () => {
  write({ a: 1 })
  clear()
  assert.equal(read(), null)
})

test('clear is a no-op when no state file exists', () => {
  clear()
  assert.equal(read(), null)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
