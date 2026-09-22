import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

const dir = mkdtempSync(join(tmpdir(), 'mp-daemon-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const {
  cleanupAll, cleanupLegacy, cleanupStale, clearOwnedState, previewHealth, runDaemon,
} = await import('../src/daemon.js')

// runDaemon calls process.exit(1) on tunnel failure and installs real
// SIGINT/SIGTERM handlers plus TTL timers — none of which a test can let
// through unmodified. A generous ttlMinutes keeps the TTL timer from firing
// during a test; handle.dispose() (added alongside the startTunnelFn seam)
// removes the signal listeners and clears the timers so nothing leaks onto
// the shared test-runner process between tests.
async function withFakeDaemon(targetPort, overrides, fn) {
  const handle = await runDaemon({
    targetPort,
    ttlMinutes: 60,
    graceMinutes: 10,
    galleryDir: join(dir, `gallery-${targetPort}`),
    startTunnelFn: async () => ({ url: `https://fake-${targetPort}.trycloudflare.com`, pid: 999_990 - targetPort }),
    ...overrides,
  })
  try {
    return await fn(handle)
  } finally {
    handle.dispose()
  }
}

test('runDaemon 接受注入的隧道启动器：状态槽落地隧道 URL 与本进程的 daemonPid（Gap 2）', async () => {
  const port = 6300
  await withFakeDaemon(port, {}, async (handle) => {
    const s = state.read(port)
    assert.equal(s.tunnelUrl, `https://fake-${port}.trycloudflare.com`, '不该真的去起 cloudflared')
    assert.equal(s.daemonPid, process.pid)
    assert.equal(s.proxyPort, handle.proxyPort)
    handle.shutdown()
  })
  assert.equal(state.read(port), null, 'shutdown 之后槽位必须清掉')
})

test('runDaemon 接好了代理的 onWindowOpen：真实请求命中兑换路径后，graceOpenedAt 落地到状态文件（Gap 2）', async () => {
  const port = 6301
  await withFakeDaemon(port, {}, async (handle) => {
    const before = state.read(port)
    assert.equal(before.graceOpenedAt, undefined, '还没人兑换过')

    await fetch(`http://127.0.0.1:${before.proxyPort}/?t=${before.sessionToken}`, { redirect: 'manual' })

    const after = state.read(port)
    assert.equal(typeof after.graceOpenedAt, 'number', 'onWindowOpen 必须把时刻写进状态文件')
    handle.shutdown()
  })
})

test('runDaemon 不传 graceMinutes 时窗口默认等于 ttl：同一链接整个生命周期内可以反复兑换', async () => {
  const port = 6302
  await withFakeDaemon(port, { graceMinutes: undefined }, async (handle) => {
    const s = state.read(port)
    assert.equal(s.graceMs, 60 * 60_000, '默认窗口必须跟 ttlMinutes 一样长，而不是固定 10 分钟')

    const url = `http://127.0.0.1:${s.proxyPort}/?t=${s.sessionToken}`
    const first = await fetch(url, { redirect: 'manual' })
    assert.equal(first.status, 302)
    const second = await fetch(url, { redirect: 'manual' })
    assert.equal(second.status, 302, '复用同一条链接不能再 404——这就是把默认窗口对齐 ttl 的目的')
    handle.shutdown()
  })
})

test('runDaemon 在隧道就绪前就占住槽位，但绝不提前落下令牌（附着的前提）', async () => {
  const port = 6304
  let duringEstablish = null

  await withFakeDaemon(port, {
    startTunnelFn: async () => {
      duringEstablish = state.read(port)
      return { url: `https://fake-${port}.trycloudflare.com`, pid: 999_000 }
    },
  }, async (handle) => {
    assert.ok(duringEstablish, '隧道还没起来时就该有记录了——否则并发的 start 只能盲起第二个 daemon')
    assert.equal(duringEstablish.daemonPid, process.pid)
    assert.equal(duringEstablish.tunnelUrl, undefined)
    assert.equal(duringEstablish.sessionToken, undefined,
      '就绪前落下令牌，等于允许打印一条还没人能访问的链接')
    assert.equal(previewHealth(duringEstablish).active, false,
      '占位记录不能被任何人当成可用预览')
    handle.shutdown()
  })
})

test('runDaemon 把隧道阶段写进状态文件，等待中的 start 才有东西可看', async () => {
  const port = 6305
  let afterProgress = null

  await withFakeDaemon(port, {
    startTunnelFn: async (_proxyPort, { onProgress }) => {
      onProgress({ stage: 'registering', attempt: 2, tries: 4 })
      afterProgress = state.read(port)
      return { url: `https://fake-${port}.trycloudflare.com`, pid: 999_000 }
    },
  }, async (handle) => {
    assert.equal(afterProgress.stage, 'registering')
    assert.equal(afterProgress.attempt, 2)
    assert.equal(afterProgress.tries, 4)
    assert.equal(state.read(port).stage, 'ready', '成功之后阶段要落到 ready')
    handle.shutdown()
  })
})

test('runDaemon 返回的 shutdown 只清理仍属于自己的槽位（Gap 2）', async () => {
  const port = 6302
  await withFakeDaemon(port, {}, async (handle) => {
    // 模拟这一格已经被新 daemon 接管（双起，或两个并发的
    // `mp start --port N`）：旧 daemon 的 shutdown 不许把它抹掉。
    state.write(port, { daemonPid: 424_242 })

    handle.shutdown()

    const s = state.read(port)
    assert.ok(s, '不是自己的槽位时必须原样留下')
    assert.equal(s.daemonPid, 424_242, '不能把新 daemon 的记录抹掉')
  })
  state.clear(port)
})

test('runDaemon 返回的 shutdown 清理自己仍拥有的槽位（Gap 2）', async () => {
  const port = 6303
  await withFakeDaemon(port, {}, async (handle) => {
    assert.ok(state.read(port), '起来之后应该有状态')
    handle.shutdown()
    assert.equal(state.read(port), null, 'shutdown 拥有槽位时必须清掉它')
  })
})

// Two of the three original no-argument tests here ('is a no-op when there
// is no state' and 'removes state whose expiry has passed') were dropped:
// ported to the port(port, patch) signature they duplicated coverage already
// present below ('cleanupStale 对不存在的预览是无操作' for the no-op case;
// 'cleanupStale 只清理指定端口' for the write-then-clear case — cleanupStale
// itself never inspects expiresAt, so the "expiry" test exercised nothing
// that write-then-clear didn't already). This one is kept and ported because
// it is the only test that puts *live-looking-but-actually-dead* pids
// through killRecorded's isAlive() skip path.
test('cleanupStale clears state referencing dead pids', () => {
  state.write(6001, { tunnelPid: 999_999, daemonPid: 999_998, tunnelUrl: 'https://x.trycloudflare.com' })
  const r = cleanupStale(6001)
  assert.equal(r.killed, 0, 'dead pids need no killing')
  assert.equal(state.read(6001), null, 'state must be wiped')
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

test('cleanupAll 清扫 list() 看不见的损坏状态文件，并如实报告（Finding 2）', () => {
  cleanupAll()
  mkdirSync(state.previewsDir(), { recursive: true })
  const corrupt = join(state.previewsDir(), '6123.json')
  writeFileSync(corrupt, '{"tunnelPid": 4242, "daemo', 'utf8') // 写到一半被打断

  // list() 跳过它，所以按 list() 收网的旧实现永远扫不到这一格，
  // 其 cloudflared 会一直挂着，且下一次 start 还会再起一个 daemon。
  assert.equal(state.list().some((s) => s.targetPort === 6123), false)

  const r = cleanupAll()

  assert.equal(existsSync(corrupt), false, '损坏的槽位必须被清掉')
  assert.deepEqual(r.unreadable, [6123], '读不出 pid 就杀不掉，必须单独报出来，不能算作干净地停掉了')
})

test('cleanupAll 仍然照常清扫读得出的槽位', () => {
  cleanupAll()
  state.write(6124, { tunnelUrl: 'https://a.trycloudflare.com' })
  writeFileSync(join(state.previewsDir(), '6125.json'), 'garbage', 'utf8')

  const r = cleanupAll()

  assert.deepEqual(state.list(), [])
  assert.deepEqual(r.unreadable, [6125])
  assert.equal(existsSync(state.statePath(6124)), false)
})

test('clearOwnedState 只清理仍属于自己的槽位（Finding 3）', () => {
  // 老 daemon 的 TTL 到点时，这一格可能已经被新 daemon 接管了
  //（双起，或两个并发的 mp start --port N）。无条件 clear 会抹掉新 daemon
  // 的记录，把它的隧道变成孤儿——status/stop 从此都找不到它。
  state.write(6200, { daemonPid: 4242, tunnelUrl: 'https://new.trycloudflare.com' })

  assert.equal(clearOwnedState(6200, 999_998), false, '不是自己的槽位，不许动')
  assert.ok(state.read(6200), '新 daemon 的记录必须原样留下')

  assert.equal(clearOwnedState(6200, 4242), true, '是自己的槽位就照常清理')
  assert.equal(state.read(6200), null)
})

test('clearOwnedState 对不存在的槽位是无操作', () => {
  assert.equal(clearOwnedState(6201, 4242), false)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

// 「预览到期只关了隧道，网页服务器留在本机」——2026-09-22 用户在手机上撞到的
// 那次，点开新链接看到的是别的任务半天前留在那个端口上的页面。--serve 把服务器
// 放进 daemon 自己的进程里，就是为了让它跟着预览一起死。
test('--serve：页面由 daemon 自己端着，shutdown 之后那个端口必须彻底空出来', async () => {
  const port = 6330
  const site = join(dir, 'served-site')
  mkdirSync(site, { recursive: true })
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>端给你看</title>')

  await withFakeDaemon(port, { serve: { root: site, file: null } }, async (handle) => {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(res.status, 200, 'daemon 起来了就该能直接访问被端的页面')
    assert.match(await res.text(), /端给你看/)

    const s = state.read(port)
    assert.equal(s.serve, site, 'status 要说得出这条预览端的是什么，否则没人知道它还在')

    handle.shutdown()
    // 关掉之后端口必须能被别人重新占上——这正是从前做不到的那一点。
    const reclaim = createServer()
    await new Promise((ok, no) => {
      reclaim.once('error', no)
      reclaim.listen(port, '127.0.0.1', ok)
    })
    await new Promise((r) => reclaim.close(r))
  })
})

test('--serve 撞上已被占用的端口：当场失败并说清楚，而不是把隧道接到别人的服务器上', async () => {
  const port = 6331
  const squatter = createServer((_, res) => res.end('我是先来的'))
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r))
  const site = join(dir, 'served-site-2')
  mkdirSync(site, { recursive: true })
  writeFileSync(join(site, 'index.html'), '<!doctype html>x')

  const exits = []
  const realExit = process.exit
  process.exit = (code) => { exits.push(code); throw new Error('exit') }
  try {
    await assert.rejects(() => withFakeDaemon(port, { serve: { root: site, file: null } }, async () => {}))
  } finally {
    process.exit = realExit
    await new Promise((r) => squatter.close(r))
  }
  assert.deepEqual(exits, [1], '绑不上就该退出，不能继续往下起隧道')
  assert.match(state.read(port).error, /already in use/)
  assert.equal(state.read(port).errorReason, 'serve-bind')
  state.clear(port)
})
