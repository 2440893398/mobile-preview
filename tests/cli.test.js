import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formatCapture, formatStart, formatStatus } from '../src/cli.js'
import { isAlive } from '../src/tunnel.js'

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

function seedPreview(dir, port, patch = {}) {
  mkdirSync(join(dir, 'previews'), { recursive: true })
  writeFileSync(join(dir, 'previews', `${port}.json`), JSON.stringify({
    tunnelUrl: `https://p${port}.trycloudflare.com`,
    sessionToken: TOK,
    expiresAt: Date.now() + 60_000,
    tunnelPid: 999_999,
    daemonPid: 999_998,
    targetPort: port,
    artifacts: [],
    ...patch,
  }), 'utf8')
  return join(dir, 'previews', `${port}.json`)
}

function mp(dir, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, MP_STATE_DIR: dir },
    encoding: 'utf8',
  })
}

test('formatStatus 报告每条预览的端口、链接与剩余时间', () => {
  const out = formatStatus([
    { targetPort: 4321, tunnelUrl: URL_, sessionToken: TOK, expiresAt: Date.now() + 30 * 60_000, artifacts: ['a.png'] },
  ])
  assert.match(out, /port 4321/)
  assert.ok(out.includes(`${URL_}/?t=${TOK}`), out)
  assert.match(out, /expires in 30 min/)
  assert.match(out, /artifacts: 1/)
})

test('formatStatus 在没有预览时明说', () => {
  assert.equal(formatStatus([]), 'no active preview')
})

test('formatStatus 逐条列出多个预览', () => {
  const out = formatStatus([
    { targetPort: 3000, tunnelUrl: URL_, sessionToken: TOK, expiresAt: Date.now() + 60_000, artifacts: [] },
    { targetPort: 4321, tunnelUrl: URL_, sessionToken: TOK, expiresAt: Date.now() + 60_000, artifacts: [] },
  ])
  assert.match(out, /port 3000/)
  assert.match(out, /port 4321/)
})

test('status 清掉 pid 已死的预览', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  const p = seedPreview(dir, 4321)

  const res = mp(dir, ['status'])

  assert.equal(res.status, 0)
  assert.match(res.stdout, /stale; cleaning up/)
  assert.equal(existsSync(p), false)
  rmSync(dir, { recursive: true, force: true })
})

test('status 清掉旧版遗留的单槽状态文件并说明清了什么', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  const legacy = join(dir, 'state.json')
  writeFileSync(legacy, JSON.stringify({
    tunnelUrl: 'https://legacy.trycloudflare.com',
    tunnelPid: 999_999,
    daemonPid: 999_998,
  }), 'utf8')

  const res = mp(dir, ['status'])

  assert.equal(res.status, 0)
  assert.match(res.stdout, /legacy/i)
  assert.equal(existsSync(legacy), false)
  rmSync(dir, { recursive: true, force: true })
})

test('start 不复用 pid 已死的预览', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  const p = seedPreview(dir, 1)

  const res = mp(dir, ['start', '--port', '1'])

  assert.equal(res.status, 1)
  assert.doesNotMatch(res.stdout, /p1\.trycloudflare\.com/)
  assert.match(res.stderr, /nothing is listening/)
  assert.equal(existsSync(p), false)
  rmSync(dir, { recursive: true, force: true })
})

test('start 在别的端口有活预览时不会把那条交出去', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  // 用当前进程的 pid 冒充活着的 daemon 与隧道，让 4321 那条判定为 active
  seedPreview(dir, 4321, { tunnelPid: process.pid, daemonPid: process.pid })

  const res = mp(dir, ['start', '--port', '1'])

  assert.equal(res.status, 1, '端口 1 无监听，应当失败')
  assert.doesNotMatch(res.stdout, /p4321\.trycloudflare\.com/, '绝不能把 4321 的链接交给端口 1')
  assert.match(res.stderr, /nothing is listening/)
  rmSync(dir, { recursive: true, force: true })
})

test('capture 在没有活预览时报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['capture'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /no active preview/)
  rmSync(dir, { recursive: true, force: true })
})

test('多条活预览时 capture 省略 --port 会报错并列出候选', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  seedPreview(dir, 3000, { tunnelPid: process.pid, daemonPid: process.pid })
  seedPreview(dir, 4321, { tunnelPid: process.pid, daemonPid: process.pid })

  const res = mp(dir, ['capture'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /3000/)
  assert.match(res.stderr, /4321/)
  assert.match(res.stderr, /--port/)
  rmSync(dir, { recursive: true, force: true })
})

test('多条活预览时 stop 省略 --port 会报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  seedPreview(dir, 3000, { tunnelPid: process.pid, daemonPid: process.pid })
  seedPreview(dir, 4321, { tunnelPid: process.pid, daemonPid: process.pid })

  const res = mp(dir, ['stop'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--port/)
  rmSync(dir, { recursive: true, force: true })
})

test('stop --all 停掉全部预览', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  seedPreview(dir, 3000)
  seedPreview(dir, 4321)

  const res = mp(dir, ['stop', '--all'])

  assert.equal(res.status, 0)
  assert.equal(existsSync(join(dir, 'previews', '3000.json')), false)
  assert.equal(existsSync(join(dir, 'previews', '4321.json')), false)
  rmSync(dir, { recursive: true, force: true })
})

test('stop 在没有预览时成功退出，不报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['stop'])

  assert.equal(res.status, 0, 'stop 的语义是「确保没有预览在跑」，本来就没有即已达成')
  assert.match(res.stdout, /stopped/)
  rmSync(dir, { recursive: true, force: true })
})

test('只有一条活预览时 stop 可以省略 --port', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  // A disposable process stands in for "alive", not process.pid: this test
  // actually reaches killTree (unlike the other process.pid-seeded tests
  // above, which all bail out before cleanupStale runs), and on Windows
  // killTree is `taskkill /PID <pid> /T /F` — verified by direct repro to
  // kill the *calling* process when pointed at its own pid, since /T tears
  // down the whole tree rooted there. Using our own pid would kill this test
  // runner mid-assertion instead of the intended target.
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  // unref so a leaked child never keeps the test worker's event loop alive.
  dummy.unref()
  const p = seedPreview(dir, 4321, { tunnelPid: dummy.pid, daemonPid: dummy.pid })

  try {
    const res = mp(dir, ['stop'])

    assert.equal(res.status, 0)
    assert.equal(existsSync(p), false)
  } finally {
    // kill() in `finally` so an assertion failure above still reaps the
    // child instead of hanging `node --test` on a referenced setInterval.
    dummy.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('daemon 已死但隧道还活着时 stop 省略 --port 仍会收网（Finding 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  // daemonPid dead (default seedPreview pid, never alive), tunnelPid a real
  // live process standing in for an orphaned cloudflared. previewHealth
  // requires BOTH pids alive, so this preview is "stale", not "active" —
  // resolvePort therefore returns null and `stop` must fall into the
  // port === null branch that Finding 1 fixes (cleanupAll instead of
  // cleanupLegacy). Before the fix, this orphaned tunnel would be left
  // running while `mp stop` reported success.
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  dummy.unref()
  const p = seedPreview(dir, 4321, { tunnelPid: dummy.pid })

  try {
    const res = mp(dir, ['stop'])

    assert.equal(res.status, 0)
    assert.match(res.stdout, /stopped \(1 process tree\(s\) terminated\)/)
    assert.equal(existsSync(p), false, 'stale slot must be swept, not left behind')
    assert.equal(isAlive(dummy.pid), false, 'the orphaned tunnel process must actually be killed')
  } finally {
    dummy.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
