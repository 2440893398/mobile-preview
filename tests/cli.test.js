import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formatCapture, formatStart, formatStatus } from '../src/cli.js'
import { isAlive } from '../src/tunnel.js'

const URL_ = 'https://tidy-pear.trycloudflare.com'
const TOK = 'a'.repeat(43)
const BIN = fileURLToPath(new URL('../src/bin.js', import.meta.url))
const DAEMON_ENTRY = fileURLToPath(new URL('../src/daemon-entry.js', import.meta.url))

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

test('formatCapture includes resource type in failed request diagnostics', () => {
  const out = formatCapture({
    tunnelUrl: URL_, galleryToken: TOK, shots: [], video: null,
    consoleErrors: [],
    failedRequests: [{ url: `${URL_}/src/main.ts?t=123`, status: 404, resourceType: 'script' }],
  })
  assert.match(out, /404 \[script\] https:\/\/tidy-pear\.trycloudflare\.com\/src\/main\.ts\?t=123/)
})

test('formatCapture 把 favicon 这类噪音单列，不和真正的错误混在一起', () => {
  const out = formatCapture({
    tunnelUrl: URL_,
    galleryToken: TOK,
    shots: [],
    video: null,
    consoleErrors: [],
    failedRequests: [
      { url: `${URL_}/src/main.tsx`, status: 404, resourceType: 'script', severity: 'error' },
      { url: `${URL_}/favicon.ico`, status: 404, resourceType: 'image', severity: 'warning' },
    ],
  })

  assert.match(out, /FAILED REQUESTS \(1\)/, '真正的错误只算那一条')
  assert.match(out, /IGNORABLE \(1\)/)
  const failedBlock = out.slice(out.indexOf('FAILED REQUESTS'), out.indexOf('IGNORABLE'))
  assert.doesNotMatch(failedBlock, /favicon/, 'favicon 不该出现在错误区里')
})

test('formatCapture 带出 console 错误的来源位置', () => {
  const out = formatCapture({
    tunnelUrl: URL_,
    galleryToken: TOK,
    shots: [],
    video: null,
    consoleErrors: [{ text: 'TypeError: x is not a function', url: `${URL_}/app.js`, line: 12 }],
    failedRequests: [],
  })

  assert.match(out, /TypeError: x is not a function \(https:\/\/tidy-pear\.trycloudflare\.com\/app\.js:12\)/)
})

test('formatCapture 仍然接受纯字符串的 console 错误（旧记录不该炸掉输出）', () => {
  const out = formatCapture({
    tunnelUrl: URL_, galleryToken: TOK, shots: [], video: null,
    consoleErrors: ['plain string error'],
    failedRequests: [],
  })

  assert.match(out, /plain string error/)
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
  assert.ok(out.includes(`${URL_}/?__mp_token=${TOK}`), out)
  assert.match(out, /expires in 30 min/)
})

test('新链接一律用 __mp_token，绝不再发 ?t=——那正是和 Vite 撞车的那个名字', () => {
  const out = formatStart({
    tunnelUrl: URL_, sessionToken: TOK, expiresAt: Date.now() + 60_000, dev: true,
  })
  assert.doesNotMatch(out, /[?&]t=/, 'Vite 用 ?t=<timestamp> 做模块缓存击穿，预览链接不能占用这个名字')
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
  assert.ok(out.includes(`${URL_}/?__mp_token=${TOK}`), out)
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

test('formatStatus 标注宽限窗口已关闭的预览（Finding 8）', () => {
  // The user starts a preview, taps the link, then twenty minutes later asks
  // for it again. Reprinting the same ?t= url with no signal sends them into
  // the deliberately uninformative 404 — the exact trial-run failure this
  // branch exists to fix, through a different door.
  const now = Date.now()
  const out = formatStatus([{
    targetPort: 4321,
    tunnelUrl: URL_,
    sessionToken: TOK,
    expiresAt: now + 20 * 60_000,
    artifacts: [],
    graceMs: 10 * 60_000,
    graceOpenedAt: now - 20 * 60_000,
  }], now)

  assert.match(out, /no longer exchangeable/)
  assert.match(out, /mp stop && mp start/, '必须给出可执行的补救动作')
})

test('formatStatus 不标注窗口还开着的预览（Finding 8）', () => {
  const now = Date.now()
  const out = formatStatus([{
    targetPort: 4321,
    tunnelUrl: URL_,
    sessionToken: TOK,
    expiresAt: now + 20 * 60_000,
    artifacts: [],
    graceMs: 10 * 60_000,
    graceOpenedAt: now - 60_000,
  }], now)

  assert.doesNotMatch(out, /no longer exchangeable/)
})

test('formatStatus 不标注还没人兑换过的预览（Finding 8）', () => {
  const now = Date.now()
  const out = formatStatus([{
    targetPort: 4321,
    tunnelUrl: URL_,
    sessionToken: TOK,
    expiresAt: now + 20 * 60_000,
    artifacts: [],
    graceMs: 10 * 60_000,
  }], now)

  assert.doesNotMatch(out, /no longer exchangeable/, '窗口从首次兑换才开始计时')
})

test('--grace 不是数字时立刻退出并点名该 flag（Finding 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  // `--grace 10m` used to become NaN, and NaN made the grace window永不关闭：
  // 会话 URL 就此变成永久凭证，而 start 与 status 都不会露出半点风声。
  const res = mp(dir, ['start', '--port', '1', '--grace', '10m'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--grace/)
  assert.match(res.stderr, /10m/)
  assert.doesNotMatch(res.stderr, /nothing is listening/, '应当在校验阶段就退出')
  rmSync(dir, { recursive: true, force: true })
})

test('--ttl 不是数字时立刻退出并点名该 flag（Finding 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['start', '--port', '1', '--ttl', 'abc'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--ttl/)
  assert.match(res.stderr, /abc/)
  assert.doesNotMatch(res.stderr, /nothing is listening/)
  rmSync(dir, { recursive: true, force: true })
})

test('start --port 不是数字时立刻退出并点名该 flag（Finding 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['start', '--port', 'abc'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--port/)
  assert.match(res.stderr, /abc/)
  assert.doesNotMatch(res.stderr, /127\.0\.0\.1:NaN/, '不该带着 NaN 一路走下去')
  rmSync(dir, { recursive: true, force: true })
})

test('stop --port abc 是错误，不是「停掉了端口 NaN」（Finding 5）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['stop', '--port', 'abc'])

  assert.equal(res.status, 1, 'stop 的契约是「确保没有预览在跑」，什么都没做就不能报成功')
  assert.match(res.stderr, /--port/)
  assert.doesNotMatch(res.stdout, /stopped port NaN/)
  rmSync(dir, { recursive: true, force: true })
})

test('stop --port 99999 拒绝越界端口，不是报「stopped port 99999」了事', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  // 99999 是有限数，能通过旧的 numericFlag，但根本不是合法端口（上限
  // 65535）。旧代码会一路走到底，打印 stopped port 99999、退出码 0——stop
  // 的整个契约是「确保没有预览在跑」，什么都没找到、什么都没做却报成功，
  // 正是 --port abc 那个 bug 的更安静的回声。
  const res = mp(dir, ['stop', '--port', '99999'])

  assert.equal(res.status, 1, 'stop 的契约是「确保没有预览在跑」，什么都没做就不能报成功')
  assert.match(res.stderr, /--port/)
  assert.match(res.stderr, /99999/)
  assert.doesNotMatch(res.stdout, /stopped port 99999/)
  rmSync(dir, { recursive: true, force: true })
})

test('start --port 超出 1-65535 范围时拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['start', '--port', '99999'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--port/)
  assert.match(res.stderr, /99999/)
  rmSync(dir, { recursive: true, force: true })
})

test('start --port 0 时拒绝（下界是 1，不是 0）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['start', '--port', '0'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--port/)
  rmSync(dir, { recursive: true, force: true })
})

test('start --port 带小数时拒绝，不是悄悄截断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['start', '--port', '3.5'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--port/)
  rmSync(dir, { recursive: true, force: true })
})

test('start --ttl 40000（分钟）超过 setTimeout 的 2^31-1 毫秒上限时拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  // 40000 分钟 * 60_000 = 2,400,000,000ms，超过 2^31-1（2,147,483,647）。
  // Node 会把这种超限的 setTimeout 静默钳成 1ms 定时器，daemon 瞬间自杀——
  // 这条命令必须在校验阶段就被拒绝，而不是走到 daemon 里才暴毙。
  const res = mp(dir, ['start', '--port', '1', '--ttl', '40000'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--ttl/)
  assert.match(res.stderr, /40000/)
  assert.doesNotMatch(res.stderr, /nothing is listening/, '应当在校验阶段就退出')
  rmSync(dir, { recursive: true, force: true })
})

test('start --ttl 0 时拒绝（下界是 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['start', '--port', '1', '--ttl', '0'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--ttl/)
  rmSync(dir, { recursive: true, force: true })
})

test('start --grace -1 时拒绝（下界是 0）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['start', '--port', '1', '--grace', '-1'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--grace/)
  rmSync(dir, { recursive: true, force: true })
})

test('start --grace 0 依旧放行——0 是合法的一次性语义，不是要拒绝的下界', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = mp(dir, ['start', '--port', '1', '--grace', '0'])

  assert.equal(res.status, 1, '端口 1 没有监听，失败是校验通过之后的事')
  assert.doesNotMatch(res.stderr, /--grace/, 'grace 0 必须通过校验，不该被当成越界')
  assert.match(res.stderr, /nothing is listening/, '证明确实走过了校验阶段')
  rmSync(dir, { recursive: true, force: true })
})

test('光秃秃的 --port 是错误，绝不当作「没给 --port」去猜（Finding 5）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  dummy.unref()
  const p = seedPreview(dir, 4321, { tunnelPid: dummy.pid, daemonPid: dummy.pid })

  try {
    // 打错一个 flag 就去动一条用户根本没点名的预览，正是端口消解设计要杜绝的
    const res = mp(dir, ['stop', '--port'])

    assert.equal(res.status, 1)
    assert.match(res.stderr, /--port/)
    assert.equal(existsSync(p), true, '没点名的预览不该被碰')
    assert.equal(isAlive(dummy.pid), true, '更不该被杀掉')
  } finally {
    dummy.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start 也清扫旧版遗留的单槽状态文件（Finding 4）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  const legacy = join(dir, 'state.json')
  writeFileSync(legacy, JSON.stringify({
    tunnelUrl: 'https://legacy.trycloudflare.com',
    tunnelPid: 999_999,
    daemonPid: 999_998,
  }), 'utf8')

  // 升级后第一条命令通常就是 start；此前它不扫遗留文件，老 daemon
  // 会继续用另一个 URL、另一个令牌服务同一个应用。
  const res = mp(dir, ['start', '--port', '1'])

  assert.match(res.stdout, /legacy/i)
  assert.equal(existsSync(legacy), false)
  rmSync(dir, { recursive: true, force: true })
})

test('start 遇到本端口的损坏状态槽位时拒绝双起，而不是当成没有预览悄悄再起一个（Gap 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  mkdirSync(join(dir, 'previews'), { recursive: true })
  const corrupt = join(dir, 'previews', '4321.json')
  // 截断在写到 tunnelPid/daemonPid 之后——它们是 write() 落盘的第 2、3 个
  // key，真实的半截文件里大概率还留着这两个字段，只是解析不出来。
  writeFileSync(corrupt, '{"tunnelUrl":"https://x.trycloudflare.com","tunnelPid":4242,"daemo', 'utf8')

  const res = mp(dir, ['start', '--port', '4321'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /corrupt/i)
  assert.match(res.stderr, /4321\.json/, '必须点名是哪个文件')
  assert.match(res.stderr, /stop --all/, '必须给出可执行的补救动作')
  assert.doesNotMatch(res.stderr, /unrecoverable|无法恢复/i, '只能说解析不出来，不能说 pid 原则上救不回来了')
  assert.doesNotMatch(res.stderr, /nothing is listening/, '必须在探测端口之前就拒绝，不能走到那一步')
  assert.equal(existsSync(corrupt), true, '损坏槽位必须原样保留，不能被 start 动，不能被当成「没有预览」')
  rmSync(dir, { recursive: true, force: true })
})

test('恰好一条活预览时 stop 仍会清扫别的端口上的损坏槽位（Gap 4）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  mkdirSync(join(dir, 'previews'), { recursive: true })
  const corrupt = join(dir, 'previews', '4321.json')
  writeFileSync(corrupt, '{"tunnelPid": 4242, "daemo', 'utf8')

  // resolvePort 会落到这一条活预览上，cleanupStale(3000) 只碰 3000 这一格——
  // 旧代码从不经过 cleanupAll，4321 的损坏槽位（以及它可能引用的 cloudflared）
  // 就永远留在那儿，且对 status/stop 都不可见。
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  dummy.unref()
  seedPreview(dir, 3000, { tunnelPid: dummy.pid, daemonPid: dummy.pid })

  try {
    const res = mp(dir, ['stop'])

    assert.equal(res.status, 0)
    assert.match(res.stdout, /stopped port 3000/)
    assert.equal(existsSync(corrupt), false, '损坏槽位必须被清掉，不能因为不是目标端口就放过')
    assert.match(res.stdout, /4321/, '清掉了什么必须报出来，不能悄悄删掉')
    assert.match(res.stdout, /may still be running/, 'pid 读不出来就杀不掉，必须说清楚')
  } finally {
    dummy.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status 会清扫 list() 看不见的损坏槽位（Gap 4）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  mkdirSync(join(dir, 'previews'), { recursive: true })
  const corrupt = join(dir, 'previews', '4321.json')
  writeFileSync(corrupt, '{"tunnelPid": 4242, "daemo', 'utf8')

  // state.list() 跳过解析不了的条目，cmdStatus 原本只在 list() 给出的条目上
  // 做 previewHealth 判断，从不触达 cleanupAll——这一格连同它可能引用的
  // cloudflared 对 status 永远不可见。
  const res = mp(dir, ['status'])

  assert.equal(res.status, 0)
  assert.equal(existsSync(corrupt), false, '损坏槽位必须被清掉')
  assert.match(res.stdout, /4321/, '清掉了什么必须报出来')
  assert.match(res.stdout, /may still be running/)
  rmSync(dir, { recursive: true, force: true })
})

test('恰好一条活预览时 stop 仍清扫遗留文件（Finding 4）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  const legacy = join(dir, 'state.json')
  writeFileSync(legacy, JSON.stringify({
    tunnelUrl: 'https://legacy.trycloudflare.com',
    tunnelPid: 999_999,
    daemonPid: 999_998,
  }), 'utf8')

  // 这一条走的是 resolvePort 找到端口的分支——它从不经过 cleanupAll，
  // 于是遗留文件被绕开，而输出照样写着 stopped。
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  dummy.unref()
  seedPreview(dir, 4321, { tunnelPid: dummy.pid, daemonPid: dummy.pid })

  try {
    const res = mp(dir, ['stop'])

    assert.equal(res.status, 0)
    assert.match(res.stdout, /legacy/i)
    assert.equal(existsSync(legacy), false)
  } finally {
    dummy.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('daemon 起不来时 start 立刻说明，而不是干等满整个隧道预算（Finding 6）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  const srv = createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port

  // 在 galleryDir 该在的位置放一个*文件*：runDaemon 的第一句就是
  // mkdirSync(galleryDir)，它会抛 EEXIST，于是 daemon 在 spawn cloudflared
  // 或写下任何状态之前就死了——正是「daemon 早死」的形状。
  mkdirSync(join(dir, 'gallery'), { recursive: true })
  writeFileSync(join(dir, 'gallery', String(port)), 'not a directory', 'utf8')

  try {
    const t0 = Date.now()
    const res = mp(dir, ['start', '--port', String(port)])
    const elapsed = Date.now() - t0

    assert.equal(res.status, 1)
    assert.match(res.stderr, /daemon exited \(code 1\)/)
    assert.ok(elapsed < 30_000, `必须立刻返回，实际等了 ${elapsed}ms（预算是 136s）`)
  } finally {
    srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('daemon-entry 面对畸形参数给一行说明，而不是裸 SyntaxError（Finding 6）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))

  const res = spawnSync(process.execPath, [DAEMON_ENTRY, '{ not json'], {
    env: { ...process.env, MP_STATE_DIR: dir },
    encoding: 'utf8',
  })

  assert.equal(res.status, 1)
  assert.doesNotMatch(res.stderr, /SyntaxError/, '不该把裸异常摔到用户脸上')
  assert.doesNotMatch(res.stderr, /^\s+at /m, '不该打印堆栈')
  assert.ok(res.stderr.trim().length > 0, '但也不能什么都不说')
  rmSync(dir, { recursive: true, force: true })
})

test('stop --all 报出清掉的损坏状态文件（Finding 2）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-'))
  mkdirSync(join(dir, 'previews'), { recursive: true })
  const corrupt = join(dir, 'previews', '4321.json')
  writeFileSync(corrupt, '{"tunnelPid": 4242, "daemo', 'utf8')

  const res = mp(dir, ['stop', '--all'])

  assert.equal(res.status, 0)
  assert.equal(existsSync(corrupt), false)
  assert.match(res.stdout, /4321/)
  assert.match(res.stdout, /may still be running/, 'pid 读不出来就杀不掉，必须说清楚')
  rmSync(dir, { recursive: true, force: true })
})

// mp() 用的是 spawnSync，会把测试进程的事件循环整个堵住——而下面的夹具服务器
// 就跑在这个进程里，于是浏览器永远等不到响应。要驱动一个本进程内的服务器，
// 只能异步地起 CLI。
function mpAsync(dir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, MP_STATE_DIR: dir },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

// --strict 的端到端：真的起一个浏览器去看一个真的缺资源的页面。
// 判定「页面是好的」这件事若只有人眼能做，agent 就永远只能把 404 当背景噪音。
async function withPage(html, fn) {
  const srv = createHttpServer((req, res) => {
    if (req.url === '/missing.js') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      return res.end('nope')
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))

  const dir = mkdtempSync(join(tmpdir(), 'mp-strict-'))
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  dummy.unref()
  seedPreview(dir, 4321, {
    tunnelPid: dummy.pid,
    daemonPid: dummy.pid,
    galleryDir: join(dir, 'gallery', '4321'),
  })

  try {
    return await fn(dir, `http://127.0.0.1:${srv.address().port}/`)
  } finally {
    dummy.kill()
    srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('capture --strict 在页面有资源错误时以非零退出', async () => {
  await withPage('<!doctype html><meta charset=utf-8><script src="/missing.js"></script><h1>hi</h1>',
    async (dir, url) => {
      const res = await mpAsync(dir, ['capture', url, '--strict', '--wait-ms', '0'])

      assert.equal(res.status, 1, `实得 ${res.status}: ${res.stdout}${res.stderr}`)
      assert.match(res.stdout, /FAILED REQUESTS/, '截图与诊断照常给出来，只是退出码变了')
      assert.match(res.stdout, /missing\.js/)
      assert.match(res.stderr, /--strict/)
    })
})

test('capture --strict 在页面干净时照常成功', async () => {
  await withPage('<!doctype html><meta charset=utf-8><h1>clean</h1>', async (dir, url) => {
    const res = await mpAsync(dir, ['capture', url, '--strict', '--wait-ms', '0'])

    assert.equal(res.status, 0, `实得 ${res.status}: ${res.stdout}${res.stderr}`)
    assert.match(res.stdout, /loaded clean/)
  })
})

test('capture 拒绝不认识的 --device，而不是悄悄给一台 iPhone', async () => {
  await withPage('<!doctype html><h1>x</h1>', async (dir, url) => {
    const res = await mpAsync(dir, ['capture', url, '--device', 'Nokia 3310'])

    assert.equal(res.status, 1)
    assert.match(res.stderr, /unknown --device "Nokia 3310"/)
    assert.match(res.stderr, /Pixel 7/, '要给出正确写法的例子')
  })
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
