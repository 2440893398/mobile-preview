import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLogSink,
  establishBudgetMs,
  isAlive,
  parseTunnelReady,
  parseTunnelUrl,
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
