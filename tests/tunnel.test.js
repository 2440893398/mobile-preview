import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTunnelUrl } from '../src/tunnel.js'

test('extracts the tunnel url from a cloudflared banner line', () => {
  const line = '2026-08-05T12:00:00Z INF |  https://tidy-pear-lion-nine.trycloudflare.com  |'
  assert.equal(parseTunnelUrl(line), 'https://tidy-pear-lion-nine.trycloudflare.com')
})

test('returns null when no url is present', () => {
  assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null)
})

test('does not match non-trycloudflare hosts', () => {
  assert.equal(parseTunnelUrl('https://example.com/foo'), null)
})

test('picks the first url when several appear in one chunk', () => {
  const chunk = 'https://aaa-bbb.trycloudflare.com and https://ccc-ddd.trycloudflare.com'
  assert.equal(parseTunnelUrl(chunk), 'https://aaa-bbb.trycloudflare.com')
})

test('ignores a bare hostname without scheme', () => {
  assert.equal(parseTunnelUrl('foo-bar.trycloudflare.com'), null)
})
