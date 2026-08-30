import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyTunnelFailure,
  createLogSink,
  establishBudgetMs,
  findOrphanTunnels,
  isAlive,
  isOrphanedTunnel,
  isOurTunnelCommand,
  parseCimProcesses,
  parsePsProcesses,
  parseTunnelReady,
  parseTunnelUrl,
  reapOrphanTunnels,
  stageText,
  startTunnel,
  TUNNEL_DEFAULTS,
} from '../src/tunnel.js'
import { tunnelWaitBudgetMs } from '../src/cli.js'

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
    retryDelayMs: 0,
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

// 前两次退出码 1，第三次才成功。计数落在文件里，因为每次尝试都是新进程。
const FLAKY_CLOUDFLARED = `
const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const counter = process.env.MP_TEST_COUNTER
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1
writeFileSync(counter, String(n))
if (n <= 2) {
  process.stderr.write('ERR failed to request quick Tunnel: context deadline exceeded\\n')
  process.exit(1)
}
process.stderr.write('INF |  https://fake-tunnel-under-test.trycloudflare.com  |\\n')
process.stderr.write('INF Registered tunnel connection connIndex=0\\n')
setInterval(() => {}, 1000)
`

const ALWAYS_FAILS = `
process.stderr.write('ERR failed to request quick Tunnel\\n')
process.exit(1)
`

test('startTunnel 重试到成功为止', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')

  try {
    process.env.MP_TEST_COUNTER = join(dir, 'counter')

    const t = await startTunnel(1234, {
      bin: 'fake-cloudflared',
      spawnFn: fakeSpawn(dir, FLAKY_CLOUDFLARED),
      logPath,
      retryDelayMs: 0,
    })

    try {
      assert.equal(t.url, 'https://fake-tunnel-under-test.trycloudflare.com')
      assert.equal(readFileSync(join(dir, 'counter'), 'utf8'), '3', '应当正好尝试三次')
    } finally {
      process.kill(t.pid)
    }
  } finally {
    delete process.env.MP_TEST_COUNTER
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重试之间不截断日志——失败现场才是最该留下的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')

  try {
    process.env.MP_TEST_COUNTER = join(dir, 'counter')

    const t = await startTunnel(1234, {
      bin: 'fake-cloudflared',
      spawnFn: fakeSpawn(dir, FLAKY_CLOUDFLARED),
      logPath,
      retryDelayMs: 0,
    })

    try {
      const log = readFileSync(logPath, 'utf8')
      assert.match(log, /attempt 1\/4/)
      assert.match(log, /attempt 2\/4/)
      assert.match(log, /attempt 3\/4/)
      assert.equal(
        (log.match(/failed to request quick Tunnel/g) || []).length, 2,
        '前两次的失败输出必须都还在',
      )
      assert.match(log, /Registered tunnel connection/)
    } finally {
      process.kill(t.pid)
    }
  } finally {
    delete process.env.MP_TEST_COUNTER
    rmSync(dir, { recursive: true, force: true })
  }
})

test('首次即成功时不产生多余尝试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')

  const t = await startTunnel(1234, {
    bin: 'fake-cloudflared',
    spawnFn: fakeSpawn(dir, FAKE_CLOUDFLARED),
    logPath,
    retryDelayMs: 0,
  })

  try {
    const log = readFileSync(logPath, 'utf8')
    assert.match(log, /attempt 1\/4/)
    assert.doesNotMatch(log, /attempt 2\/4/)
  } finally {
    process.kill(t.pid)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('全部尝试失败时报出次数、原因与日志路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')

  await assert.rejects(
    startTunnel(1234, {
      bin: 'fake-cloudflared',
      spawnFn: fakeSpawn(dir, ALWAYS_FAILS),
      logPath,
      tries: 3,
      retryDelayMs: 0,
    }),
    (err) => {
      assert.match(err.message, /after 3 attempts/)
      assert.match(err.message, /exited with code 1/)
      assert.ok(err.message.includes(logPath), `expected message to name ${logPath}, got: ${err.message}`)
      return true
    },
  )

  assert.match(readFileSync(logPath, 'utf8'), /attempt 3\/3/)
  rmSync(dir, { recursive: true, force: true })
})

test('startTunnel 放弃等待时指向日志文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')
  const silent = "process.stderr.write('INF starting up\\n'); setInterval(() => {}, 1000)"

  await assert.rejects(
    startTunnel(1234, {
      bin: 'fake-cloudflared',
      spawnFn: fakeSpawn(dir, silent),
      logPath,
      timeoutMs: 300,
      tries: 1,
      retryDelayMs: 0,
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

test('establishBudgetMs 用默认配置算出最坏情况的墙钟时间', () => {
  const { tries, timeoutMs, retryDelayMs } = TUNNEL_DEFAULTS
  assert.equal(establishBudgetMs(), tries * timeoutMs + (tries - 1) * retryDelayMs)
})

test('establishBudgetMs 支持逐项覆盖参数', () => {
  const opts = { tries: 5, timeoutMs: 1_000, retryDelayMs: 500 }
  assert.equal(establishBudgetMs(opts), opts.tries * opts.timeoutMs + (opts.tries - 1) * opts.retryDelayMs)
})

test('establishBudgetMs 在 tries: 1 时不叠加重试间隔', () => {
  assert.equal(establishBudgetMs({ tries: 1 }), TUNNEL_DEFAULTS.timeoutMs)
  // retryDelayMs must be irrelevant here — a single try has no gap to wait out.
  assert.equal(establishBudgetMs({ tries: 1, retryDelayMs: 999_999 }), TUNNEL_DEFAULTS.timeoutMs)
})

// The two numbers (CLI wait, startTunnel's retry budget) were specified
// independently in H4 and drifted apart. Assert the relationship, not a
// magic number, so a future change to the retry policy cannot silently
// desynchronize them again.
test('CLI 等待隧道的时限严格大于 startTunnel 的重试预算', () => {
  assert.ok(
    tunnelWaitBudgetMs() > establishBudgetMs(),
    `expected CLI wait (${tunnelWaitBudgetMs()}) to exceed the retry budget (${establishBudgetMs()})`,
  )
})

// The stub for this test never emits the ready lines on its first spawn — it
// only reports success starting with the second — so the first attempt can
// only resolve via the timeoutMs branch. It records its own pid to disk
// (keyed by attempt number, alongside MP_TEST_COUNTER) so the test can check
// afterwards whether that first child is still running.
const TIMES_OUT_ONCE_THEN_SUCCEEDS = `
const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const counter = process.env.MP_TEST_COUNTER
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1
writeFileSync(counter, String(n))
writeFileSync(counter + '.pid.' + n, String(process.pid))
if (n === 1) {
  process.stderr.write('INF starting up, attempt ' + n + '\\n')
  setInterval(() => {}, 1000)
} else {
  process.stderr.write('INF |  https://fake-tunnel-under-test.trycloudflare.com  |\\n')
  process.stderr.write('INF Registered tunnel connection connIndex=0\\n')
  setInterval(() => {}, 1000)
}
`

// 拿到 URL 但从不注册 edge——国内网络下最常见、也最伤人的一种失败：链接看着
// 好好的，手机点开却是 530 或干脆超时。
const URL_BUT_NEVER_REGISTERS = `
process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n')
process.stderr.write('INF |  https://fake-tunnel-under-test.trycloudflare.com  |\\n')
process.stderr.write('ERR Unable to reach the origin service. i/o timeout\\n')
setInterval(() => {}, 1000)
`

test('只拿到 URL、从未注册 edge 连接时，startTunnel 判定为失败而不是成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')

  await assert.rejects(
    startTunnel(1234, {
      bin: 'fake-cloudflared',
      spawnFn: fakeSpawn(dir, URL_BUT_NEVER_REGISTERS),
      logPath,
      timeoutMs: 500,
      tries: 1,
      retryDelayMs: 0,
    }),
    (err) => {
      // URL 已经打印出来了。若把「打印了 URL」当成就绪，用户会拿到一条
      // 根本没人能访问的链接——这正是要杜绝的那种「成功」。
      assert.match(err.message, /never registered an edge connection|could not reach api\.trycloudflare\.com/)
      assert.ok(err.message.includes(logPath), '失败时必须指向 cloudflared 日志')
      return true
    },
  )

  rmSync(dir, { recursive: true, force: true })
})

test('classifyTunnelFailure 认出「拿到 URL 但没注册 edge」', () => {
  const c = classifyTunnelFailure([
    'INF |  https://x-y-z.trycloudflare.com  |',
    'ERR failed to serve tunnel connection error="timeout"',
  ].join('\n'))

  assert.equal(c.reason, 'edge-unregistered')
  assert.match(c.hint, /530|blocked|proxy/i, '必须给出可执行的下一步')
})

test('classifyTunnelFailure 认出根本联系不上 api.trycloudflare.com', () => {
  const c = classifyTunnelFailure(
    'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded',
  )

  assert.equal(c.reason, 'api-unreachable')
  assert.match(c.message, /api\.trycloudflare\.com/)
})

test('classifyTunnelFailure 认出本地端口不可达，不去怪 Cloudflare', () => {
  const c = classifyTunnelFailure(
    'ERR failed to connect to origin: dial tcp 127.0.0.1:5173: connect: connection refused',
  )

  assert.equal(c.reason, 'origin-unreachable')
  assert.match(c.message, /local port/i)
})

test('classifyTunnelFailure 说不出所以然时也不假装知道', () => {
  const c = classifyTunnelFailure('INF starting up')
  assert.equal(c.reason, 'unknown')
  assert.match(c.hint, /log/i)
})

test('stageText 把内部阶段名翻成人话，未知阶段原样透出', () => {
  assert.match(stageText('registering'), /edge connection/i)
  assert.match(stageText('connecting'), /quick tunnel/i)
  assert.equal(stageText('something-new'), 'something-new')
})

test('startTunnel 把阶段变化报给调用方，url 与 ready 是两个不同的时刻', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const seen = []

  const t = await startTunnel(1234, {
    bin: 'fake-cloudflared',
    spawnFn: fakeSpawn(dir, FAKE_CLOUDFLARED),
    logPath: join(dir, 'cloudflared.log'),
    retryDelayMs: 0,
    onProgress: (p) => seen.push(p.stage),
  })

  try {
    assert.deepEqual(seen, ['connecting', 'registering', 'ready'],
      '「拿到 url」和「注册成功」必须分别报出来，否则等待期间无从判断卡在哪一步')
  } finally {
    process.kill(t.pid)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('onProgress 抛异常也不能拖垮隧道启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))

  const t = await startTunnel(1234, {
    bin: 'fake-cloudflared',
    spawnFn: fakeSpawn(dir, FAKE_CLOUDFLARED),
    logPath: join(dir, 'cloudflared.log'),
    retryDelayMs: 0,
    onProgress: () => { throw new Error('状态文件写不进去') },
  })

  try {
    assert.equal(t.url, 'https://fake-tunnel-under-test.trycloudflare.com')
  } finally {
    process.kill(t.pid)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超时触发的重试会回收上一次尝试的子进程，不留活体 (Finding 2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')
  const counterPath = join(dir, 'counter')

  // 2000ms, not a tighter value: attempt 2 has to cold-start a node process
  // inside this budget, and under a loaded machine that has taken >300ms. A
  // too-tight budget times out attempt 2 as well and the test fails for a
  // reason that has nothing to do with reclamation.
  const timeoutMs = 2000

  try {
    process.env.MP_TEST_COUNTER = counterPath

    const startedAt = Date.now()
    const t = await startTunnel(1234, {
      bin: 'fake-cloudflared',
      spawnFn: fakeSpawn(dir, TIMES_OUT_ONCE_THEN_SUCCEEDS),
      logPath,
      timeoutMs,
      tries: 2,
      retryDelayMs: 0,
    })
    const elapsed = Date.now() - startedAt

    try {
      assert.equal(t.url, 'https://fake-tunnel-under-test.trycloudflare.com')
      assert.equal(readFileSync(counterPath, 'utf8'), '2', '第一次必须超时，第二次才应当发生')
      assert.ok(
        elapsed >= timeoutMs,
        `第一次尝试必须是走「超时」分支结束的（唯一需要显式 killTree 的路径），` +
        `整轮耗时应当不少于 ${timeoutMs}ms，实测 ${elapsed}ms`,
      )

      const log = readFileSync(logPath, 'utf8')
      assert.match(log, /attempt 1\/2/, '第一次尝试必须真的跑过')
      assert.match(log, /attempt 2\/2/, '第二次尝试必须真的跑过')
      assert.match(log, /starting up/, '第一次尝试的输出必须留痕，证明它不是被跳过的')

      const firstPid = Number(readFileSync(`${counterPath}.pid.1`, 'utf8'))
      assert.notEqual(firstPid, t.pid, '两次尝试必须是不同的子进程')
      assert.equal(isAlive(firstPid), false, '超时的第一次尝试必须被 killTree 回收，不能残留')
    } finally {
      process.kill(t.pid)
    }
  } finally {
    delete process.env.MP_TEST_COUNTER
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- windowless background processes, and reclaiming what they leave behind ---

test('cloudflared 以 windowsHide 启动——否则会在桌面上开出一个黑窗口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  let seen = null

  const t = await startTunnel(1234, {
    bin: 'fake-cloudflared',
    logPath: join(dir, 'cloudflared.log'),
    spawnFn: (bin, args, opts) => {
      seen = opts
      return fakeSpawn(dir, FAKE_CLOUDFLARED)(bin, args, opts)
    },
  })

  try {
    // 守护进程自己是 detached 起的（Windows 上即 DETACHED_PROCESS，没有控制台
    // 可继承），所以少了这一项，Windows 会给 cloudflared 新分配一个控制台窗口。
    assert.equal(seen.windowsHide, true)
  } finally {
    process.kill(t.pid)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只认本项目 spawn 出来的那条 cloudflared 命令行', () => {
  const ours = '"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel'
    + ' --no-autoupdate --protocol http2 --url http://127.0.0.1:53806'
  assert.equal(isOurTunnelCommand(ours), true)
  assert.equal(isOurTunnelCommand('/usr/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:9'), true)

  // 用户自己跑的具名隧道 / 服务：回收器绝不能碰。
  assert.equal(isOurTunnelCommand('cloudflared tunnel run my-prod-tunnel'), false)
  assert.equal(isOurTunnelCommand('cloudflared service install'), false)
  // --url 指向别处的，也不是我们的。
  assert.equal(isOurTunnelCommand('cloudflared tunnel --no-autoupdate --url http://10.0.0.5:80'), false)
  assert.equal(isOurTunnelCommand(''), false)
  assert.equal(isOurTunnelCommand(null), false)
})

test('孤儿的判据是父进程，不是状态文件', () => {
  const dead = () => false
  const alive = () => true

  // 守护进程已死：没有任何东西还会执行它的 TTL，这才是孤儿。
  assert.equal(isOrphanedTunnel({ ppid: 4242 }, { isAliveFn: dead, win: true }), true)
  // 守护进程还活着：既可能是健康的预览，也可能是 spawn 完还没写状态文件的那
  // 一瞬间。两种都不能杀。
  assert.equal(isOrphanedTunnel({ ppid: 4242 }, { isAliveFn: alive, win: true }), false)
  // POSIX 上孤儿会被 init 收养，父进程永远"活着"，所以判据换成 ppid 1。
  assert.equal(isOrphanedTunnel({ ppid: 1 }, { isAliveFn: alive, win: false }), true)
  assert.equal(isOrphanedTunnel({ ppid: 4242 }, { isAliveFn: alive, win: false }), false)
})

test('解析 CIM 输出：单个进程时 ConvertTo-Json 给的是对象而不是数组', () => {
  const one = JSON.stringify({
    ProcessId: 17284, ParentProcessId: 26588, CommandLine: 'cloudflared.exe tunnel --url x',
  })
  assert.deepEqual(parseCimProcesses(one), [
    { pid: 17284, ppid: 26588, cmd: 'cloudflared.exe tunnel --url x' },
  ])

  const two = JSON.stringify([
    { ProcessId: 1, ParentProcessId: 2, CommandLine: 'a' },
    { ProcessId: 3, ParentProcessId: 4, CommandLine: null },
  ])
  assert.deepEqual(parseCimProcesses(two), [
    { pid: 1, ppid: 2, cmd: 'a' },
    { pid: 3, ppid: 4, cmd: '' },
  ])

  // PowerShell 起不来、被策略拦掉、输出被 AV 吃掉——一律当作"没什么可回收"。
  assert.deepEqual(parseCimProcesses(''), [])
  assert.deepEqual(parseCimProcesses('not json'), [])
})

test('解析 ps 输出：pid、ppid、以及带空格的完整命令行', () => {
  const out = [
    '  501     1 /usr/local/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:5173',
    '  502   501 /bin/sh -c something else',
    'garbage line',
    '',
  ].join('\n')

  assert.deepEqual(parsePsProcesses(out), [
    { pid: 501, ppid: 1, cmd: '/usr/local/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:5173' },
    { pid: 502, ppid: 501, cmd: '/bin/sh -c something else' },
  ])
})

function fakeWindowsProcessTable(rows) {
  return (file, _args) => {
    if (file === 'tasklist') {
      return rows.map((r) => `"cloudflared.exe","${r.pid}","Console","1","30,000 K"`).join('\r\n')
    }
    return JSON.stringify(rows.map((r) => ({
      ProcessId: r.pid, ParentProcessId: r.ppid, CommandLine: r.cmd,
    })))
  }
}

const OURS = 'cloudflared.exe tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:53806'

test('findOrphanTunnels 只挑出父进程已死、且是我们起的那些', () => {
  const execFn = fakeWindowsProcessTable([
    { pid: 100, ppid: 900, cmd: OURS }, // 守护进程已死 → 孤儿
    { pid: 200, ppid: 901, cmd: OURS }, // 守护进程还在 → 放过
    { pid: 300, ppid: 900, cmd: 'cloudflared.exe tunnel run my-prod-tunnel' }, // 不是我们的
  ])

  const found = findOrphanTunnels({
    execFn, win: true, isAliveFn: (pid) => pid === 901,
  })
  assert.deepEqual(found.map((p) => p.pid), [100])
})

test('状态文件里记着的隧道，连命令行都不用去查', () => {
  const calls = []
  const table = fakeWindowsProcessTable([{ pid: 100, ppid: 900, cmd: OURS }])
  const execFn = (file, args) => {
    calls.push(file)
    return table(file, args)
  }

  const found = findOrphanTunnels({
    execFn, win: true, known: new Set([100]), isAliveFn: () => false,
  })

  assert.deepEqual(found, [])
  // 常见情况是每条 cloudflared 都有主：到 tasklist 为止就该收工，不该再去
  // 起一个 PowerShell 查 CIM。
  assert.deepEqual(calls, ['tasklist'])
})

test('reapOrphanTunnels 杀掉孤儿并把 pid 报出来', () => {
  const killed = []
  const pids = reapOrphanTunnels({
    execFn: fakeWindowsProcessTable([{ pid: 100, ppid: 900, cmd: OURS }]),
    win: true,
    isAliveFn: () => false,
    killFn: (pid) => killed.push(pid),
  })

  assert.deepEqual(pids, [100])
  assert.deepEqual(killed, [100])
})

test('进程表读不出来时，回收器什么都不做', () => {
  const pids = reapOrphanTunnels({
    execFn: () => { throw new Error('tasklist: access is denied') },
    win: true,
    isAliveFn: () => false,
    killFn: () => assert.fail('不该杀任何东西'),
  })
  assert.deepEqual(pids, [])
})
