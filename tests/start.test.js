import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formatStartTimeout, tunnelWaitBudgetMs } from '../src/cli.js'

const BIN = fileURLToPath(new URL('../src/bin.js', import.meta.url))
const TOK = 'a'.repeat(43)
const URL_ = 'https://tidy-pear.trycloudflare.com'

// Written the way state.write writes: beside the target, then renamed over it.
// A test that wrote in place could hand a half-written file to the CLI it is
// driving and fail for a reason that has nothing to do with what it asserts.
function patchState(dir, port, patch) {
  const previews = join(dir, 'previews')
  mkdirSync(previews, { recursive: true })
  const file = join(previews, `${port}.json`)
  const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const tmp = `${file}.test.tmp`
  writeFileSync(tmp, JSON.stringify({ ...prior, ...patch }, null, 2), 'utf8')
  renameSync(tmp, file)
}

function liveProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  child.unref()
  return child
}

function runMp(dir, args) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, MP_STATE_DIR: dir },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  return { child, done, output: () => stdout + stderr }
}

// 等 CLI 自己说到哪一步了，再给它打下一发状态补丁。固定的 500/600ms 定时器
// 赌的是 node 进程能在补丁落地前完成启动并读到 establishing 态——整套件
// 负载高时赌输，CLI 首读就看到中间态，走进完全不同的分支。
async function seen(run, pattern, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (pattern.test(run.output())) return
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${pattern} in: ${run.output()}`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-start-'))
  const dummy = liveProcess()
  return (async () => {
    try {
      return await fn(dir, dummy)
    } finally {
      dummy.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })()
}

const READY = {
  tunnelUrl: URL_,
  sessionToken: TOK,
  galleryToken: TOK,
  expiresAt: Date.now() + 30 * 60_000,
  stage: 'ready',
}

test('隧道还在建立时，第二次 start 附着到已有的 daemon，并最终打印出链接', () => withFixture(async (dir, dummy) => {
  // 真实故障的形状：第一次 mp start 返回了，但没给出 URL；隔一会儿 status
  // 显示预览其实起来了，再跑一次 start 才拿到链接。此前这一格根本没有状态
  // 文件可看，第二条 start 只会再起一个 daemon 去抢同一个槽位。
  patchState(dir, 4321, {
    daemonPid: dummy.pid, targetPort: 4321, stage: 'connecting', attempt: 1, tries: 4,
  })

  const run = runMp(dir, ['start', '--port', '4321'])
  await seen(run, /already starting/)
  patchState(dir, 4321, { stage: 'registering' })
  await seen(run, /edge connection/)
  patchState(dir, 4321, READY)

  const { code, stdout, stderr } = await run.done
  const all = stdout + stderr

  assert.equal(code, 0, `实得 ${code}: ${all}`)
  assert.ok(stdout.includes(`${URL_}/?__mp_token=${TOK}`), `链接必须落在 stdout: ${all}`)
  assert.match(all, /already starting/, '必须说明它是附着到已有 daemon，而不是又起了一个')
}))

test('等待期间逐阶段汇报，不再是一言不发地卡着', () => withFixture(async (dir, dummy) => {
  patchState(dir, 4321, {
    daemonPid: dummy.pid, targetPort: 4321, stage: 'connecting', attempt: 2, tries: 4,
  })

  const run = runMp(dir, ['start', '--port', '4321'])
  await seen(run, /attempt 2\/4/)
  patchState(dir, 4321, { stage: 'registering' })
  await seen(run, /edge connection/)
  patchState(dir, 4321, READY)

  const { stdout, stderr } = await run.done
  const all = stdout + stderr

  assert.match(all, /quick tunnel.*attempt 2\/4/s, '第一阶段与重试次数都要露出来')
  assert.match(all, /edge connection/, '「拿到 url」与「注册成功」必须分开汇报——530 就出在这一段')
}))

test('--json 在 stdout 上只吐一个可解析的对象，人看的话都挪到 stderr', () => withFixture(async (dir, dummy) => {
  patchState(dir, 4321, { daemonPid: dummy.pid, targetPort: 4321, stage: 'connecting' })

  const run = runMp(dir, ['start', '--port', '4321', '--json'])
  await seen(run, /already starting/)
  patchState(dir, 4321, READY)

  const { code, stdout, stderr } = await run.done

  assert.equal(code, 0, stderr)
  const payload = JSON.parse(stdout)
  assert.equal(payload.status, 'ready')
  assert.equal(payload.port, 4321)
  assert.equal(payload.url, `${URL_}/?__mp_token=${TOK}`)
  assert.equal(typeof payload.expiresAt, 'number')
  assert.match(stderr, /already starting/, '进度说明必须走 stderr，不能污染 stdout')
}))

test('daemon 报错时 --json 也给出结构化的失败，而不是只往 stderr 扔一行', () => withFixture(async (dir, dummy) => {
  patchState(dir, 4321, { daemonPid: dummy.pid, targetPort: 4321, stage: 'connecting' })

  const run = runMp(dir, ['start', '--port', '4321', '--json'])
  await seen(run, /already starting/)
  patchState(dir, 4321, {
    error: 'cloudflared failed to establish a tunnel after 4 attempts',
    errorReason: 'edge-unregistered',
  })

  const { code, stdout } = await run.done

  assert.equal(code, 1)
  const payload = JSON.parse(stdout)
  assert.equal(payload.status, 'error')
  assert.match(payload.error, /failed to establish a tunnel/)
  assert.equal(payload.reason, 'edge-unregistered')
}))

test('已经活着的预览：start --json 直接把现成的链接结构化交出来', () => withFixture(async (dir, dummy) => {
  patchState(dir, 4321, {
    ...READY, daemonPid: dummy.pid, tunnelPid: dummy.pid, targetPort: 4321,
  })

  const { code, stdout } = await runMp(dir, ['start', '--port', '4321', '--json']).done

  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).url, `${URL_}/?__mp_token=${TOK}`)
}))

test('status 不会把正在建立隧道的 daemon 当成陈旧记录清掉', () => withFixture(async (dir, dummy) => {
  // start 超时后让人「过一会儿看 status」，而 status 顺手把那个还在努力的
  // daemon 清了，是最糟糕的一种自相矛盾。
  patchState(dir, 4321, {
    daemonPid: dummy.pid, targetPort: 4321, stage: 'registering', attempt: 3, tries: 4,
  })

  const { code, stdout } = await runMp(dir, ['status']).done

  assert.equal(code, 0)
  assert.match(stdout, /still starting/)
  assert.match(stdout, /attempt 3\/4/)
  assert.equal(existsSync(join(dir, 'previews', '4321.json')), true, '还在建立的槽位不能被清掉')
}))

test('status --json 只输出可解析的数组', () => withFixture(async (dir, dummy) => {
  patchState(dir, 4321, {
    ...READY, daemonPid: dummy.pid, tunnelPid: dummy.pid, targetPort: 4321,
  })

  const { stdout } = await runMp(dir, ['status', '--json']).done

  const rows = JSON.parse(stdout)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].port, 4321)
  assert.equal(rows[0].url, `${URL_}/?__mp_token=${TOK}`)
}))

test('超时信息点名最后到达的阶段、daemon 是否还活着，以及日志在哪', () => {
  const stillTrying = formatStartTimeout({
    port: 4173,
    latest: { stage: 'registering', attempt: 3, tries: 4, daemonPid: 4242 },
    budgetMs: tunnelWaitBudgetMs(),
    logPath: 'C:\\state\\previews\\4173.cloudflared.log',
    daemonAlive: true,
  })

  assert.match(stillTrying, /last stage: .*edge connection.*\(attempt 3\/4\)/)
  assert.match(stillTrying, /pid 4242.*still running/s)
  assert.match(stillTrying, /mp status/)
  assert.match(stillTrying, /mp stop --port 4173/)
  assert.match(stillTrying, /4173\.cloudflared\.log/)

  const gone = formatStartTimeout({
    port: 4173,
    latest: { stage: 'connecting' },
    budgetMs: 1000,
    logPath: '/tmp/x.log',
    daemonAlive: false,
  })

  assert.match(gone, /no daemon is running for port 4173/)
  assert.doesNotMatch(gone, /still running/)
})

// ---- Windows PowerShell ----

const ps = process.platform === 'win32' ? test : test.skip

ps('PowerShell 里 mp 确实是 Move-ItemProperty 的别名——文档那句话不是传说', () => {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Alias mp'], {
    encoding: 'utf8',
  })

  assert.match(res.stdout, /Move-ItemProperty/,
    '若这条不再成立，README 与 skill 里「用 mp.cmd」的说明就该改了')
})

ps('PowerShell 下 --json 的输出能直接喂给 ConvertFrom-Json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ps-'))
  try {
    // 端口 1 上不会有东西在听，走的是失败路径——恰恰是最需要「stdout 依然是
    // 合法 JSON」的那条路径。
    const script = `$env:MP_STATE_DIR='${dir}'; `
      + `& '${process.execPath}' '${BIN}' start --port 1 --json | ConvertFrom-Json | ConvertTo-Json -Compress`
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    })

    const payload = JSON.parse(res.stdout.trim())
    assert.equal(payload.status, 'error')
    assert.match(payload.error, /nothing is listening/)
    assert.equal(payload.port, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --serve 是给「把一个网页端给手机看」用的：以前那要 AI 自己起一个静态服务器，
// 起完没人关，端口就一直被占着。三条都在起 daemon 之前就该被拦下来。
test('--serve 和 --port 不能同时给：谁在隧道那一头只能有一个答案', () => withFixture(async (dir) => {
  const page = join(dir, 'page.html')
  writeFileSync(page, '<!doctype html><title>x</title>')
  const r = await runMp(dir, ['start', '--serve', page, '--port', '4321']).done
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /--serve and --port cannot be combined/)
}))

test('--serve 和 --dev 不能同时给', () => withFixture(async (dir) => {
  const page = join(dir, 'page.html')
  writeFileSync(page, '<!doctype html><title>x</title>')
  const r = await runMp(dir, ['start', '--serve', page, '--dev']).done
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /--serve and --dev cannot be combined/)
}))

test('--serve 指到一个不存在的路径：当场说清楚，不去起 daemon', () => withFixture(async (dir) => {
  const r = await runMp(dir, ['start', '--serve', join(dir, 'nope.html')]).done
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /no such file or directory/)
  assert.equal(existsSync(join(dir, 'previews')), false, '连槽位都不该建')
}))
