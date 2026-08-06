import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogSink, parseTunnelReady, parseTunnelUrl, startTunnel } from '../src/tunnel.js'

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

test('detects when cloudflared has registered an edge connection', () => {
  assert.equal(parseTunnelReady('INF Registered tunnel connection connIndex=0'), true)
  assert.equal(parseTunnelReady('INF +--------------------------------------------------------------------------------+'), false)
})

test('log sink appends every chunk it is given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-sink-'))
  const file = join(dir, 'cloudflared.log')

  const sink = createLogSink(file)
  sink.write('INF first line\n')
  sink.write('ERR second line\n')

  assert.equal(readFileSync(file, 'utf8'), 'INF first line\nERR second line\n')
  rmSync(dir, { recursive: true, force: true })
})

test('log sink creates the parent directory when it is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-sink-'))
  const file = join(dir, 'nested', 'deeper', 'cloudflared.log')

  createLogSink(file).write('INF hello\n')

  assert.equal(readFileSync(file, 'utf8'), 'INF hello\n')
  rmSync(dir, { recursive: true, force: true })
})

// A stand-in for the cloudflared binary: emits the two lines startTunnel waits
// for, then stays alive like the real process does.
const FAKE_CLOUDFLARED = `
process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n')
process.stderr.write('INF |  https://fake-tunnel-under-test.trycloudflare.com  |\\n')
process.stderr.write('INF Registered tunnel connection connIndex=0 location=lax07\\n')
setInterval(() => {}, 1000)
`

function fakeSpawn(dir, body) {
  const script = join(dir, 'fake-cloudflared.js')
  writeFileSync(script, body, 'utf8')
  return (_bin, args, opts) => spawn(process.execPath, [script, ...args], opts)
}

test('startTunnel mirrors cloudflared output into the log file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')

  const t = await startTunnel(1234, {
    bin: 'fake-cloudflared',
    spawnFn: fakeSpawn(dir, FAKE_CLOUDFLARED),
    logPath,
  })

  try {
    assert.equal(t.url, 'https://fake-tunnel-under-test.trycloudflare.com')
    const log = readFileSync(logPath, 'utf8')
    assert.match(log, /Requesting new quick Tunnel/)
    assert.match(log, /Registered tunnel connection/)
  } finally {
    process.kill(t.pid)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startTunnel starts each session with a fresh log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')
  writeFileSync(logPath, 'INF output from a previous session\n', 'utf8')

  const t = await startTunnel(1234, {
    bin: 'fake-cloudflared',
    spawnFn: fakeSpawn(dir, FAKE_CLOUDFLARED),
    logPath,
  })

  try {
    const log = readFileSync(logPath, 'utf8')
    assert.doesNotMatch(log, /previous session/)
    assert.match(log, /Registered tunnel connection/)
  } finally {
    process.kill(t.pid)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startTunnel points at the log file when it gives up waiting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')
  const silent = "process.stderr.write('INF starting up\\n'); setInterval(() => {}, 1000)"

  await assert.rejects(
    startTunnel(1234, {
      bin: 'fake-cloudflared',
      spawnFn: fakeSpawn(dir, silent),
      logPath,
      timeoutMs: 300,
    }),
    (err) => {
      assert.match(err.message, /did not establish a tunnel connection/)
      assert.ok(err.message.includes(logPath), `expected message to name ${logPath}, got: ${err.message}`)
      return true
    },
  )

  assert.match(readFileSync(logPath, 'utf8'), /starting up/)
  rmSync(dir, { recursive: true, force: true })
})
