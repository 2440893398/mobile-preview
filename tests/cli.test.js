import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formatCapture, formatStart } from '../src/cli.js'

const URL_ = 'https://tidy-pear.trycloudflare.com'
const TOK = 'a'.repeat(43)
const BIN = fileURLToPath(new URL('../src/bin.js', import.meta.url))

test('formatCapture emits a pasteable markdown image line per shot', () => {
  const out = formatCapture({
    tunnelUrl: URL_, galleryToken: TOK,
    shots: ['shot-1.png'], video: null,
    consoleErrors: [], failedRequests: [],
  })
  assert.ok(out.includes(`![shot-1](${URL_}/_a/${TOK}/shot-1.png)`), out)
})

test('formatCapture emits a link, not an image tag, for video', () => {
  const out = formatCapture({
    tunnelUrl: URL_, galleryToken: TOK,
    shots: [], video: 'reel.mp4',
    consoleErrors: [], failedRequests: [],
  })
  assert.ok(out.includes(`[reel.mp4](${URL_}/_a/${TOK}/reel.mp4)`), out)
  assert.ok(!out.includes('![reel'), 'video must not be an image embed')
})

test('formatCapture warns loudly when console errors exist', () => {
  const out = formatCapture({
    tunnelUrl: URL_, galleryToken: TOK,
    shots: ['shot-1.png'], video: null,
    consoleErrors: ['TypeError: x is not a function'],
    failedRequests: [{ url: `${URL_}/a.js`, status: 500 }],
  })
  assert.match(out, /CONSOLE ERRORS \(1\)/)
  assert.match(out, /TypeError: x is not a function/)
  assert.match(out, /FAILED REQUESTS \(1\)/)
})

test('formatCapture states cleanliness explicitly when there is nothing wrong', () => {
  const out = formatCapture({
    tunnelUrl: URL_, galleryToken: TOK,
    shots: ['shot-1.png'], video: null,
    consoleErrors: [], failedRequests: [],
  })
  assert.match(out, /no console errors, no failed requests/)
})

test('formatStart puts the token in the url and states the expiry', () => {
  const expiresAt = Date.now() + 30 * 60_000
  const out = formatStart({ tunnelUrl: URL_, sessionToken: TOK, expiresAt, dev: false })
  assert.ok(out.includes(`${URL_}/?t=${TOK}`), out)
  assert.match(out, /expires in 30 min/)
})

test('formatStart flags dev mode and its hmr limitation', () => {
  const out = formatStart({
    tunnelUrl: URL_, sessionToken: TOK,
    expiresAt: Date.now() + 60_000, dev: true,
  })
  assert.match(out, /dev mode/i)
  assert.match(out, /HMR/)
})

test('status cleans a future state whose recorded pids are dead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify({
    tunnelUrl: 'https://dead.trycloudflare.com',
    sessionToken: TOK,
    expiresAt: Date.now() + 60_000,
    tunnelPid: 999_999,
    daemonPid: 999_998,
    artifacts: [],
  }), 'utf8')

  const res = spawnSync(process.execPath, [BIN, 'status'], {
    env: { ...process.env, MP_STATE_DIR: dir },
    encoding: 'utf8',
  })

  assert.equal(res.status, 0)
  assert.match(res.stdout, /stale; cleaning up/)
  assert.equal(existsSync(statePath), false)
  rmSync(dir, { recursive: true, force: true })
})

test('start does not reuse a future state whose recorded pids are dead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify({
    tunnelUrl: 'https://dead.trycloudflare.com',
    sessionToken: TOK,
    expiresAt: Date.now() + 60_000,
    tunnelPid: 999_999,
    daemonPid: 999_998,
    artifacts: [],
  }), 'utf8')

  const res = spawnSync(process.execPath, [BIN, 'start', '--port', '1'], {
    env: { ...process.env, MP_STATE_DIR: dir },
    encoding: 'utf8',
  })

  assert.equal(res.status, 1)
  assert.doesNotMatch(res.stdout, /dead\.trycloudflare\.com/)
  assert.match(res.stderr, /nothing is listening/)
  assert.equal(existsSync(statePath), false)
  rmSync(dir, { recursive: true, force: true })
})
