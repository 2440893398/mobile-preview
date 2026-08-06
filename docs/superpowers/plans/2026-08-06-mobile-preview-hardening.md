# mobile-preview 加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 2026-08-06 首次手机端试跑暴露的五个问题：一次性令牌被预取烧毁、长 URL 送不到手机、隧道建立无重试、全局单槽状态互踩、国内网络实况无文档。

**Architecture:** 状态存储从单个 `state.json` 改为 `previews/<端口>.json` 一文件一预览，端口即键，多条预览并存且无写竞争；`proxy.js` 的一次性兑换布尔量换成宽限窗口时间戳；`startTunnel` 内部循环重试并把日志截断时机从「每次尝试」上移到「每次调用」。

**Tech Stack:** Node.js ≥20（原生 ESM）、`node:test` + `node:assert/strict`、零运行时依赖（`playwright` 仅供 `capture.js`）、cloudflared quick tunnel。

## Global Constraints

- 规格书：`docs/superpowers/specs/2026-08-06-mobile-preview-hardening-design.md`。前置规格 `2026-08-05-mobile-preview-design.md` 的 §4.1 被本次修订。
- 一切鉴权失败返回 **404**，永不返回 401/403。
- `/@fs/`、`.env`、`.git/` 在任何模式下都被拦截。
- 测试一律用 `MP_STATE_DIR` 指向临时目录，**禁止触碰真实状态目录**。
- 全程 TDD：先写失败测试，跑到它真的失败，再写最小实现。
- 每个任务结束时 `npm test` 全绿才提交。
- 提交信息用祈使句英文，与既有历史一致（`feat:` / `fix:` / `docs:`）。
- Node 原生 ESM：源码用 `import`，**写进临时目录的测试桩脚本除外**——它们落在没有 `type: module` 的临时目录里，必须用 `require`。

---

### Task 1: state.js 改为按端口多槽

**Files:**
- Modify: `src/state.js`（全量重写，现 37 行）
- Test: `tests/state.test.js`（全量重写，现 49 行）

**Interfaces:**
- Consumes: 无（本任务是其余任务的地基）
- Produces:
  - `previewsDir() → string`
  - `statePath(port) → string`
  - `tunnelLogPath(port) → string`
  - `galleryDir(port) → string`
  - `legacyStatePath() → string`
  - `read(port) → object | null`
  - `write(port, patch) → object`
  - `clear(port) → void`
  - `list() → Array<object>`，每项含 `targetPort: number`，按端口升序

- [ ] **Step 1: 写失败测试**

全量替换 `tests/state.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-state-'))
process.env.MP_STATE_DIR = dir

const {
  read, write, clear, list,
  statePath, tunnelLogPath, galleryDir, previewsDir, legacyStatePath,
} = await import('../src/state.js')

test('每条预览的状态文件以端口命名，放在 previews 目录下', () => {
  assert.equal(previewsDir(), join(dir, 'previews'))
  assert.equal(statePath(4321), join(dir, 'previews', '4321.json'))
})

test('隧道日志与状态文件同目录，按端口区分', () => {
  assert.equal(tunnelLogPath(4321), join(dir, 'previews', '4321.cloudflared.log'))
})

test('产物目录按端口分开', () => {
  assert.equal(galleryDir(4321), join(dir, 'gallery', '4321'))
  assert.notEqual(galleryDir(4321), galleryDir(3000))
})

test('遗留的单槽状态文件仍在根目录', () => {
  assert.equal(legacyStatePath(), join(dir, 'state.json'))
})

test('没有状态文件时 read 返回 null', () => {
  assert.equal(read(4321), null)
})

test('write 后 read 能读回', () => {
  write(4321, { tunnelUrl: 'https://a.trycloudflare.com', ttl: 30 })
  assert.equal(read(4321).tunnelUrl, 'https://a.trycloudflare.com')
  assert.equal(read(4321).ttl, 30)
})

test('write 是合并而非替换', () => {
  write(4321, { proxyPort: 41234 })
  const s = read(4321)
  assert.equal(s.proxyPort, 41234)
  assert.equal(s.tunnelUrl, 'https://a.trycloudflare.com')
})

test('两个端口的状态互不干扰', () => {
  write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })
  assert.equal(read(4321).tunnelUrl, 'https://a.trycloudflare.com')
  assert.equal(read(3000).tunnelUrl, 'https://b.trycloudflare.com')
})

test('clear 只删指定端口', () => {
  write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })
  clear(3000)
  assert.equal(read(3000), null)
  assert.equal(read(4321).tunnelUrl, 'https://a.trycloudflare.com')
})

test('clear 对不存在的预览是无操作', () => {
  clear(9999)
  assert.equal(read(9999), null)
})

test('list 返回全部预览并按端口升序', () => {
  write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })
  write(8080, { tunnelUrl: 'https://c.trycloudflare.com' })
  const ports = list().map((s) => s.targetPort)
  assert.deepEqual(ports, [3000, 4321, 8080])
})

test('list 给出的 targetPort 是数字，以文件名为准', () => {
  write(3000, { targetPort: 'nonsense' })
  const found = list().find((s) => s.targetPort === 3000)
  assert.equal(typeof found.targetPort, 'number')
})

test('list 跳过损坏的 json 而不抛异常', () => {
  writeFileSync(join(previewsDir(), '7777.json'), '{ not json', 'utf8')
  const ports = list().map((s) => s.targetPort)
  assert.ok(!ports.includes(7777), '损坏条目不应出现在结果里')
  assert.ok(ports.includes(4321), '其余条目仍应返回')
})

test('list 跳过文件名不是纯数字的条目', () => {
  writeFileSync(join(previewsDir(), 'notes.json'), '{"tunnelUrl":"x"}', 'utf8')
  writeFileSync(join(previewsDir(), '4321.cloudflared.log'), 'INF x', 'utf8')
  assert.equal(list().filter((s) => Number.isNaN(s.targetPort)).length, 0)
})

test('previews 目录不存在时 list 返回空数组', () => {
  const empty = mkdtempSync(join(tmpdir(), 'mp-state-empty-'))
  const prev = process.env.MP_STATE_DIR
  process.env.MP_STATE_DIR = empty
  try {
    assert.deepEqual(list(), [])
  } finally {
    process.env.MP_STATE_DIR = prev
    rmSync(empty, { recursive: true, force: true })
  }
})

test('read 遇到损坏 json 返回 null 而非抛异常', () => {
  mkdirSync(previewsDir(), { recursive: true })
  writeFileSync(statePath(5555), '{ not json', 'utf8')
  assert.equal(read(5555), null)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/state.test.js`
Expected: FAIL — `list is not a function`、`previewsDir is not a function`，以及 `statePath(4321)` 返回旧的 `state.json` 路径。

- [ ] **Step 3: 写实现**

全量替换 `src/state.js`：

```js
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function stateDir() {
  return process.env.MP_STATE_DIR
    || join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), 'mobile-preview')
}

export function previewsDir() {
  return join(stateDir(), 'previews')
}

// The pre-multi-slot single global slot. Kept only so cleanup can find and
// kill whatever an older version left running.
export function legacyStatePath() {
  return join(stateDir(), 'state.json')
}

export function statePath(port) {
  return join(previewsDir(), `${port}.json`)
}

export function tunnelLogPath(port) {
  return join(previewsDir(), `${port}.cloudflared.log`)
}

export function galleryDir(port) {
  return join(stateDir(), 'gallery', String(port))
}

export function read(port) {
  const f = statePath(port)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

export function write(port, patch) {
  mkdirSync(previewsDir(), { recursive: true })
  const next = { ...(read(port) || {}), ...patch }
  writeFileSync(statePath(port), JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function clear(port) {
  const f = statePath(port)
  if (existsSync(f)) rmSync(f, { force: true })
}

// Never throws: status is the last thing a user has when everything else has
// gone wrong, so a single corrupt file must not take the listing down.
export function list() {
  const dir = previewsDir()
  if (!existsSync(dir)) return []

  const out = []
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(name)
    if (!m) continue
    const s = read(m[1])
    if (!s) continue
    // The filename is the key of record — a targetPort inside the file that
    // disagrees with it is stale data.
    out.push({ ...s, targetPort: Number(m[1]) })
  }

  return out.sort((a, b) => a.targetPort - b.targetPort)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/state.test.js`
Expected: PASS，全部 16 项。

- [ ] **Step 5: 提交**

```bash
git add src/state.js tests/state.test.js
git commit -m "feat: key preview state by target port

A single global state.json meant one preview per machine and let one
session hand out another session's tunnel URL. Store one file per
preview under previews/<port>.json instead: the port is the key, each
daemon writes only its own file, and list() walks the directory.

Gallery and cloudflared log paths move under the port too — two previews
sharing one gallery directory would overwrite each other's shot-1.png."
```

---

### Task 2: daemon.js 按端口清理

**Files:**
- Modify: `src/daemon.js:7-22`（`cleanupStale`）、`src/daemon.js:43-105`（`runDaemon`）
- Test: `tests/daemon.test.js`（现 54 行，追加用例）

**Interfaces:**
- Consumes: Task 1 的 `state.read(port)` / `write(port, patch)` / `clear(port)` / `list()` / `legacyStatePath()` / `tunnelLogPath(port)`
- Produces:
  - `cleanupStale(port) → { killed: number }`
  - `cleanupLegacy() → { killed: number, found: boolean }`
  - `cleanupAll() → { killed: number, legacy: boolean }`
  - `previewHealth(s, now?) → { active, reason, deadPids? }`（签名不变）
  - `runDaemon({ targetPort, dev, ttlMinutes, graceMinutes, galleryDir })`

- [ ] **Step 1: 写失败测试**

在 `tests/daemon.test.js` 末尾（`process.on('exit', ...)` 之前）追加。文件头部已有 `process.env.MP_STATE_DIR = dir`，沿用即可。

**先处理 import，别直接粘贴**：该文件已经 import 了 `join`（用于 `mkdtempSync(join(tmpdir(), ...))`），ESM 里重复绑定同一个标识符是 SyntaxError。把下列需要的名字**并入既有的 import 语句**，已存在的不要重复写：

- `node:fs` → 需要 `existsSync`、`writeFileSync`
- `node:path` → 需要 `join`（多半已有）
- `../src/state.js` → `import * as state from '../src/state.js'`
- `../src/daemon.js` → 需要 `cleanupAll`、`cleanupLegacy`、`cleanupStale`（该文件已从此模块 import 了 `previewHealth`，追加到同一条语句里）

用例本体：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/daemon.test.js`
Expected: FAIL — `cleanupAll is not a function`、`cleanupLegacy is not a function`，且 `cleanupStale(4321)` 因签名不接受参数而清错对象。

- [ ] **Step 3: 写实现**

改 `src/daemon.js`。替换文件顶部的 import 与 `cleanupStale`：

```js
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createProxy } from './proxy.js'
import { hashToken, mintToken } from './auth.js'
import { isAlive, killTree, startTunnel } from './tunnel.js'
import * as state from './state.js'

function killRecorded(s) {
  if (!s) return 0
  const pids = [...new Set([s.tunnelPid, s.daemonPid].filter(Boolean))]
  let killed = 0

  for (const pid of pids) {
    if (!isAlive(pid)) continue
    killTree(pid)
    killed += 1
  }

  return killed
}

export function cleanupStale(port) {
  const s = state.read(port)
  if (!s) return { killed: 0 }

  const killed = killRecorded(s)
  state.clear(port)
  return { killed }
}

// Pre-multi-slot versions wrote a single state.json. Its processes outlive the
// upgrade, so find them, kill them, and drop the file. No field migration:
// reviving an old preview is worthless, not orphaning its tunnel is not.
export function cleanupLegacy() {
  const f = state.legacyStatePath()
  if (!existsSync(f)) return { killed: 0, found: false }

  let s = null
  try {
    s = JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    s = null
  }

  const killed = killRecorded(s)
  rmSync(f, { force: true })
  return { killed, found: true }
}

export function cleanupAll() {
  let killed = 0
  for (const p of state.list()) killed += cleanupStale(p.targetPort).killed

  const legacy = cleanupLegacy()
  return { killed: killed + legacy.killed, legacy: legacy.found }
}
```

`previewHealth` 保持原样不动。

替换 `runDaemon`：

```js
export async function runDaemon({
  targetPort,
  dev = false,
  ttlMinutes = 30,
  graceMinutes = 10,
  galleryDir,
}) {
  mkdirSync(galleryDir, { recursive: true })

  const galleryToken = mintToken()
  const sessionToken = mintToken()
  const expiresAt = Date.now() + ttlMinutes * 60_000

  const proxy = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt,
    graceMs: graceMinutes * 60_000,
    dev,
    targetPort,
  })

  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = proxy.address().port

  let tunnelPid = null

  const shutdown = () => {
    killTree(tunnelPid)
    proxy.close()
    state.clear(targetPort)
    process.exit(0)
  }

  const ttlTimer = setTimeout(shutdown, Math.max(0, expiresAt - Date.now()))
  ttlTimer.unref?.()
  const pollTimer = setInterval(() => {
    if (Date.now() >= expiresAt) shutdown()
  }, 15_000)
  pollTimer.unref?.()

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    const t = await startTunnel(proxyPort, { logPath: state.tunnelLogPath(targetPort) })
    tunnelPid = t.pid
    state.write(targetPort, {
      tunnelUrl: t.url,
      tunnelPid,
      daemonPid: process.pid,
      proxyPort,
      targetPort,
      dev,
      expiresAt,
      graceMs: graceMinutes * 60_000,
      galleryDir,
      galleryToken,
      sessionToken,
      artifacts: [],
    })
  } catch (err) {
    proxy.close()
    state.write(targetPort, {
      error: String(err?.message || err),
      daemonPid: process.pid,
    })
    process.exit(1)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/daemon.test.js`
Expected: PASS。

注意：此刻 `npm test` 整体仍会红——`cli.js` 还在调用旧的 `state.read()` 无参形式，`proxy.js` 还不认识 `graceMs`。这是预期的，Task 3 与 Task 4 收口。

- [ ] **Step 5: 提交**

```bash
git add src/daemon.js tests/daemon.test.js
git commit -m "feat: scope daemon cleanup to a single preview

cleanupStale takes a port and touches only that preview. cleanupAll
sweeps every slot, and cleanupLegacy kills whatever a pre-multi-slot
state.json left running before deleting it — a corrupt legacy file is
still deleted, since an unreadable record is exactly the case where an
orphaned tunnel would otherwise survive forever.

runDaemon threads graceMinutes through to the proxy."
```

---

### Task 3: cli.js 端口消解与四条命令

**Files:**
- Modify: `src/cli.js`（现 246 行）
- Modify: `src/daemon-entry.js`（现 15 行，改为接收单个 JSON 参数）
- Test: `tests/cli.test.js`（现 115 行，改写两个既有用例并追加）

**Interfaces:**
- Consumes: Task 1 的 `state.*`；Task 2 的 `cleanupStale(port)` / `cleanupAll()` / `cleanupLegacy()` / `previewHealth(s)`
- Produces:
  - `formatStart({ tunnelUrl, sessionToken, expiresAt, dev }) → string`（不变）
  - `formatCapture({...}) → string`（不变）
  - `formatStatus(previews) → string`（新增，`previews` 为含 `targetPort` / `tunnelUrl` / `sessionToken` / `expiresAt` / `artifacts` 的数组）
  - CLI：`mp start --port N [--dev] [--ttl 30] [--grace 10]`、`mp capture [--port N]`、`mp status`、`mp stop [--port N] [--all]`

- [ ] **Step 1: 写失败测试**

改写 `tests/cli.test.js` 中两个既有用例（第 70–115 行整段替换），并追加新用例。补上 import：

```js
import { formatCapture, formatStart, formatStatus } from '../src/cli.js'
import { mkdirSync } from 'node:fs'
```

替换段落与新增用例：

```js
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
  const p = seedPreview(dir, 4321, { tunnelPid: process.pid, daemonPid: process.pid })

  const res = mp(dir, ['stop'])

  assert.equal(res.status, 0)
  assert.equal(existsSync(p), false)
  rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/cli.test.js`
Expected: FAIL — `formatStatus is not a function`；`stop` / `capture` 的端口消解全部走旧的单槽逻辑。

- [ ] **Step 3: 写实现**

改 `src/cli.js`。

(a) `parseArgs` 增加 `--grace` 与 `--all`。把第 25 行的取值参数列表替换为：

```js
    if (a === '--port' || a === '--ttl' || a === '--steps' || a === '--device' || a === '--grace') {
      out[a.slice(2)] = args[++i]
      continue
    }
```

`--all` 与 `--dev` / `--video` 同属布尔，已由第 29–32 行的 `a.startsWith('--')` 兜住，无需额外分支。

(b) 顶部 import 改为：

```js
import { cleanupAll, cleanupLegacy, cleanupStale, previewHealth } from './daemon.js'
```

(c) 新增 `formatStatus` 与端口消解，插在 `formatStart` 之后：

```js
export function formatStatus(previews) {
  if (previews.length === 0) return 'no active preview'

  return previews.map((s) => {
    const mins = Math.round((s.expiresAt - Date.now()) / 60_000)
    // The url goes on its own bare line: mobile chat clients render code
    // blocks unselectable, and a link the user cannot copy is a link that
    // never arrives. See skill/SKILL.md.
    return [
      `port ${s.targetPort}:`,
      `${s.tunnelUrl}/?t=${s.sessionToken}`,
      `  expires in ${mins} min, artifacts: ${(s.artifacts || []).length}`,
    ].join('\n')
  }).join('\n\n')
}

function activePreviews() {
  return state.list().filter((s) => previewHealth(s).active)
}

// Returns the port to act on, or null when there is none. Never guesses
// between several: on a phone the user cannot see the machine's state, and
// stopping the wrong service costs more than typing --port.
function resolvePort(parsed) {
  if (parsed.port !== undefined) return Number(parsed.port)

  const active = activePreviews()
  if (active.length === 1) return active[0].targetPort
  if (active.length === 0) return null

  const ports = active.map((s) => s.targetPort).join(', ')
  console.error(`several previews are active (ports ${ports}). Pass --port to pick one.`)
  process.exit(1)
}
```

(d) `waitForState` 增加端口参数：

```js
async function waitForState(port, predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = state.read(port)
    if (s && predicate(s)) return s
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}
```

(e) `cmdStart` 全量替换：

```js
async function cmdStart(args) {
  const parsed = parseArgs(args)
  const port = Number(parsed.port ?? 5173)
  const dev = Boolean(parsed.dev)
  const ttl = Number(parsed.ttl ?? 30)
  const grace = Number(parsed.grace ?? 10)

  const existing = state.read(port)
  if (previewHealth(existing).active) {
    console.log(formatStart(startView(existing)))
    return
  }

  if (existing) cleanupStale(port)

  if (!(await portIsOpen(port))) {
    console.error(`nothing is listening on 127.0.0.1:${port}. Start your app first.`)
    process.exit(1)
  }

  const galleryDir = state.galleryDir(port)
  const child = spawn(process.execPath, [
    join(HERE, 'daemon-entry.js'),
    JSON.stringify({ targetPort: port, dev, ttlMinutes: ttl, graceMinutes: grace, galleryDir }),
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()

  const s = await waitForState(port, (x) => x.tunnelUrl || x.error)
  if (!s) {
    console.error('timed out waiting for the tunnel')
    process.exit(1)
  }
  if (s.error) {
    console.error(s.error)
    state.clear(port)
    process.exit(1)
  }

  console.log(formatStart(startView(s)))
}
```

(f) `cmdCapture` 的开头替换（保留其后的 capture 调用与输出格式化）：

```js
async function cmdCapture(args) {
  const parsed = parseArgs(args)
  const port = resolvePort(parsed)
  if (port === null) {
    console.error('no active preview. Run `mp start` first.')
    process.exit(1)
  }

  const s = state.read(port)
  if (!previewHealth(s).active) {
    if (s) cleanupStale(port)
    console.error('no active preview. Run `mp start` first.')
    process.exit(1)
  }
```

其后原样保留，但把写回状态那一行改为：

```js
  state.write(port, { artifacts: [...(s.artifacts || []), ...r.shots, r.video].filter(Boolean) })
```

(g) `cmdStatus` 全量替换：

```js
function cmdStatus() {
  const legacy = cleanupLegacy()
  if (legacy.found) {
    console.log(`cleaned up a legacy single-slot state file (${legacy.killed} process tree(s) terminated)`)
  }

  const all = state.list()
  const live = []

  for (const s of all) {
    if (s.error) {
      console.log(`port ${s.targetPort}: ${s.error}`)
      continue
    }

    const health = previewHealth(s)
    if (health.active) {
      live.push(s)
      continue
    }

    const why = health.reason === 'expired' ? 'has expired' : 'is stale'
    console.log(`port ${s.targetPort}: previous preview ${why}; cleaning up`)
    cleanupStale(s.targetPort)
  }

  console.log(formatStatus(live))
}
```

(h) `cmdStop` 全量替换：

```js
function cmdStop(args) {
  const parsed = parseArgs(args)

  if (parsed.all) {
    const r = cleanupAll()
    console.log(`stopped (${r.killed} process tree(s) terminated)`)
    return
  }

  const port = resolvePort(parsed)
  if (port === null) {
    const legacy = cleanupLegacy()
    console.log(`stopped (${legacy.killed} process tree(s) terminated)`)
    return
  }

  const r = cleanupStale(port)
  console.log(`stopped port ${port} (${r.killed} process tree(s) terminated)`)
}
```

(i) `main` **不需要改动**。分发表已经是 `fn(rest)` 调用形式，`cmdStop(args)` 拿到参数即可；`cmdStatus` 忽略多余参数也无妨。

(j) 全量替换 `src/daemon-entry.js`：

```js
import { runDaemon } from './daemon.js'

// A single JSON argument rather than positionals: the option set grows, and
// silently shifting positionals is the kind of bug that only shows up on a
// phone twenty minutes into a session.
const opts = JSON.parse(process.argv[2])

try {
  await runDaemon(opts)
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/cli.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/cli.js src/daemon-entry.js tests/cli.test.js
git commit -m "feat: resolve the target port per command

start keys off --port, so a live preview on another port is no longer
handed out as if it were yours. capture and stop take --port, default to
the only active preview, and refuse to guess when several are running.
status lists every slot and sweeps the expired ones.

stop with nothing running exits 0: its contract is 'no preview is
running', which an empty machine already satisfies.

daemon-entry now takes one JSON argument instead of four positionals."
```

---

### Task 4: proxy.js 令牌宽限窗口

**Files:**
- Modify: `src/proxy.js:87-99`（`createProxy` 签名与 `sessionTokenExchanged`）、`src/proxy.js:156-174`（兑换分支）
- Test: `tests/proxy.test.js:76-95`（改写既有的一次性用例）并追加

**Interfaces:**
- Consumes: 无（`proxy.js` 不依赖 `state.js`）
- Produces: `createProxy({ galleryDir, galleryToken, sessionHash, expiresAt, graceMs, dev, targetPort, maxFailures, failureWindowMs })`，`graceMs` 默认 `10 * 60_000`

- [ ] **Step 1: 写失败测试**

把 `tests/proxy.test.js` 第 76–95 行的 `'the query token can only be exchanged once'` 用例整段替换为下列一组：

```js
async function proxyWith(overrides) {
  const token = mintToken()
  const server = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(token),
    expiresAt: Date.now() + 60_000,
    dev: false,
    targetPort: 1,
    ...overrides,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, token, base: `http://127.0.0.1:${server.address().port}` }
}

test('宽限窗口内可以重复兑换，预取烧掉的就是第一次', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 60_000 })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 302, '窗口内第二次兑换必须仍然放行')
  assert.match(second.headers.get('set-cookie'), /^mp_session=/)
  server.close()
})

test('宽限窗口关闭后，正确的令牌也是 404', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 20 })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await new Promise((r) => setTimeout(r, 40))
  const late = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(late.status, 404)
  server.close()
})

test('窗口外的兑换计入限流——那正是泄漏重放的形状', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 20, maxFailures: 2 })

  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await new Promise((r) => setTimeout(r, 40))
  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  // 限流已触发，此时连合法 cookie 也一并挡下
  const res = await fetch(`${b}/`, { headers: { cookie: `mp_session=${token}` } })
  assert.equal(res.status, 404)
  server.close()
})

test('grace 为 0 时退回一次性语义', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 0 })

  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 404)
  server.close()
})

test('窗口从首次兑换开始计时，而非从签发开始', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 60_000 })

  // 静置一段时间后才首次兑换，窗口这时才打开
  await new Promise((r) => setTimeout(r, 60))
  const first = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  const second = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(first.status, 302)
  assert.equal(second.status, 302)
  server.close()
})

test('错误令牌在任何时候都是 404，且不打开窗口', async () => {
  const { server, token, base: b } = await proxyWith({ graceMs: 60_000 })

  const bad = await fetch(`${b}/?t=${mintToken()}`, { redirect: 'manual' })
  const good = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })

  assert.equal(bad.status, 404)
  assert.equal(good.status, 302, '错误令牌不应消耗掉真令牌的首次兑换')
  server.close()
})

test('TTL 到期优先于宽限窗口', async () => {
  const { server, token, base: b } = await proxyWith({
    graceMs: 60_000,
    expiresAt: Date.now() - 1,
  })

  const res = await fetch(`${b}/?t=${token}`, { redirect: 'manual' })
  assert.equal(res.status, 404)
  server.close()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/proxy.test.js`
Expected: FAIL — `宽限窗口内可以重复兑换` 得到 404（现行实现第二次必然作废）；`grace 为 0` 一项碰巧通过，但那是旧行为，不算数。

- [ ] **Step 3: 写实现**

改 `src/proxy.js`。

(a) `createProxy` 签名加入 `graceMs`：

```js
export function createProxy({
  galleryDir,
  galleryToken,
  sessionHash,
  expiresAt,
  dev = false,
  targetPort,
  graceMs = 10 * 60_000,
  maxFailures = 10,
  failureWindowMs = 5 * 60_000,
}) {
```

(b) 把 `let sessionTokenExchanged = false` 替换为：

```js
  // Opened by the first successful exchange, not by minting. Link prefetch in
  // a chat client burns the first exchange before the human ever taps; the
  // window is what lets the human still get in. Once it closes only the
  // cookie works, so a URL that leaks later is already dead.
  let graceUntil = null
```

(c) 把兑换分支（原第 156–174 行）替换为：

```js
    const qsToken = url.searchParams.get('t')
    if (qsToken) {
      if (!tokenMatches(qsToken, sessionHash)) {
        recordFailure(ip)
        return notFound(res)
      }

      const now = Date.now()
      if (graceUntil === null) {
        graceUntil = now + graceMs
      } else if (now >= graceUntil) {
        // A correct token arriving after the window is the shape of a replayed
        // leak, so it counts against the limiter.
        recordFailure(ip)
        return notFound(res)
      }

      url.searchParams.delete('t')
      const clean = pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '')
      const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      res.writeHead(302, {
        Location: clean,
        'Set-Cookie': `mp_session=${qsToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
        'X-Robots-Tag': 'noindex, nofollow',
      })
      res.end()
      return
    }
```

`graceMs = 0` 时首次兑换令 `graceUntil = now`，其后任何请求都满足 `now >= graceUntil`，窗口为空区间，一次性语义得以保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/proxy.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/proxy.js tests/proxy.test.js
git commit -m "feat: replace the one-shot token with a grace window

The first phone trial run proved the one-shot exchange unusable: chat
clients prefetch the link, so the exchange is spent before the human
taps, and what they get is a 404 they cannot interpret — 404 being
required, since 403 would confirm the path exists.

The window opens on the first exchange rather than at mint time, so a
token nobody touched for twenty minutes still works when the user
finally taps. A correct token arriving after the window counts against
the rate limiter: that is what a replayed leak looks like.

graceMs: 0 restores the old one-shot semantics for callers that want it."
```

---

### Task 5: tunnel.js 建立重试

**Files:**
- Modify: `src/tunnel.js:93-156`（`startTunnel` 拆成单次尝试 + 重试循环）
- Test: `tests/tunnel.test.js:115-136`（改写超时用例）并追加

**Interfaces:**
- Consumes: 无
- Produces: `startTunnel(localPort, { timeoutMs = 30000, logPath = null, bin, spawnFn, tries = 4, retryDelayMs = 2000 }) → Promise<{ url: string, pid: number }>`

- [ ] **Step 1: 写失败测试**

替换 `tests/tunnel.test.js` 第 115–136 行的超时用例，并追加重试用例：

```js
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
    delete process.env.MP_TEST_COUNTER
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重试之间不截断日志——失败现场才是最该留下的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-tunnel-'))
  const logPath = join(dir, 'cloudflared.log')
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
```

同时把既有的 `'startTunnel starts each session with a fresh log'` 用例补上 `retryDelayMs: 0`，行为不变，只是免得将来改动放慢它。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/tunnel.test.js`
Expected: FAIL — `startTunnel 重试到成功为止` 在第一次退出即 reject；日志里没有 `attempt 1/4` 标记。

- [ ] **Step 3: 写实现**

替换 `src/tunnel.js` 中 `startTunnel` 整个函数（第 93 行到文件末尾）：

```js
function attemptTunnel(localPort, { timeoutMs, bin, spawnFn, sink }) {
  return new Promise((resolve, reject) => {
    // --protocol http2 强制走 TCP。cloudflared 默认使用 QUIC/UDP 7844，
    // 该端口在中国大陆网络下干扰明显，隧道会反复重连。
    const child = spawnFn(bin, [
      'tunnel',
      '--no-autoupdate',
      '--protocol', 'http2',
      '--url', `http://127.0.0.1:${localPort}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let settled = false
    let buf = ''

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child.pid)
      reject(new Error(`cloudflared did not establish a tunnel connection within ${timeoutMs}ms`))
    }, timeoutMs)

    const onData = (d) => {
      // Keep mirroring after the tunnel is up — reconnects and edge errors
      // land here too, and that is exactly what we want on disk.
      sink.write(d.toString())
      if (settled) return
      buf += d.toString()
      const url = parseTunnelUrl(buf)
      if (!url || !parseTunnelReady(buf)) return
      settled = true
      clearTimeout(timer)
      resolve({ url, pid: child.pid })
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared exited with code ${code} before producing a url`))
    })
  })
}

export async function startTunnel(localPort, {
  timeoutMs = 30000,
  logPath = null,
  bin = findCloudflared(),
  spawnFn = spawn,
  tries = 4,
  retryDelayMs = 2000,
} = {}) {
  if (!bin) throw new Error(installHint())

  // Truncate once per call, not once per attempt: the failures that led up to
  // the last try are the whole reason the log exists.
  const sink = createLogSink(logPath, { truncate: true })
  const seeLog = logPath ? ` See ${logPath} for cloudflared output.` : ''
  let last = null

  for (let n = 1; n <= tries; n += 1) {
    sink.write(`--- attempt ${n}/${tries} ---\n`)
    try {
      return await attemptTunnel(localPort, { timeoutMs, bin, spawnFn, sink })
    } catch (err) {
      last = err
      if (n < tries) await new Promise((r) => setTimeout(r, retryDelayMs))
    }
  }

  const plural = tries === 1 ? 'attempt' : 'attempts'
  throw new Error(
    `cloudflared failed to establish a tunnel after ${tries} ${plural}: ${last?.message || last}.${seeLog}`,
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/tunnel.test.js`
Expected: PASS。

随后跑一次全量：`npm test`
Expected: 全绿。Task 1–5 到此闭合。

- [ ] **Step 5: 提交**

```bash
git add src/tunnel.js tests/tunnel.test.js
git commit -m "feat: retry tunnel establishment

Measured on the trial-run network, api.trycloudflare.com answers about
one time in three; one session needed eight attempts. A single try means
mp start simply fails on a working setup.

Four attempts, two seconds apart, each with its own handshake timeout.
The log is truncated once per call rather than once per attempt — the
failures leading up to the last try are the whole reason it exists — and
each attempt writes a separator.

Retry covers establishment only. A tunnel that drops after it is up is a
different problem and out of scope."
```

---

### Task 6: 文档

**Files:**
- Modify: `README.md`（现 38 行）
- Modify: `skill/SKILL.md`（现 29 行）

**Interfaces:**
- Consumes: Task 3 的命令面（`--grace`、`--port`、`--all`）
- Produces: 无代码接口

- [ ] **Step 1: 更新 README**

把 `README.md` 的 `## Use` 一节替换为：

（下面用四个反引号包裹，因为内容本身含有三反引号的代码块。写进 README 时用三个。）

````markdown
## Use

```bash
npm run build && npm run preview
mp start --port 4173
mp capture
mp capture --video
mp stop
```

Several previews can run at once, one per target port. `capture` and `stop`
default to the only active preview and refuse to guess when more than one is
running — pass `--port` then. `mp status` lists every slot.

| Flag | Default | Meaning |
|---|---|---|
| `--port` | 5173 | The local port to expose |
| `--ttl` | 30 | Minutes before the preview self-terminates |
| `--grace` | 10 | Minutes the `?t=` link stays exchangeable after its first use |
| `--dev` | off | Expose a dev server rather than a build (larger attack surface) |
````

在 `## Security` 一节之前插入新章节：

```markdown
## Running from mainland China

Measured 2026-08-06 on a residential connection with a local proxy available:

| | |
|---|---|
| `api.trycloudflare.com` reachable | ~1 attempt in 3, direct and through a proxy alike |
| Tunnel establishment | once on the first try, once only on the eighth |
| Throughput once up | ~50 KB/s |
| Data plane | a 527 KB download was truncated at 128 KB, then 530s |

What follows from that:

- cloudflared is forced onto `--protocol http2`. Its default QUIC/UDP 7844 is
  heavily disrupted here and the tunnel reconnects in a loop.
- `mp start` retries establishment four times before giving up. When it still
  fails, read `%LOCALAPPDATA%\mobile-preview\previews\<port>.cloudflared.log`
  — every attempt is in there, separated by `--- attempt N/M ---`.
- A tunnel that comes up can still drop later. It shows as HTTP 530 or a
  truncated transfer. There is no reconnect: run `mp start` again.
- Keep recordings short and phone-sized. At 50 KB/s a 1 MB video is 20 seconds
  of staring at a spinner.

Quick Tunnel also does not support SSE (events pile up until the connection
closes) and caps concurrent in-flight requests at 200, returning 429 beyond
that. An app that depends on SSE will look broken through the preview.
```

- [ ] **Step 2: 更新 SKILL.md**

在 `skill/SKILL.md` 的 `## Rules` 一节顶部插入两条：

```markdown
- **Output the preview link as a bare line.** Never wrap it in a code block,
  backticks, or any other markdown. Many phone clients render code blocks
  unselectable and unclickable, and a link the user cannot copy is a link that
  never arrives. This has already cost one session.
- The `?t=` link stays exchangeable for `--grace` minutes (default 10) after
  its first use, so a chat client that prefetches it does not lock the user
  out. After that only the cookie works. Do not hand the same link to two
  people expecting both to get in.
```

并把 `## Workflow` 第 4 步改为：

```markdown
4. Paste the markdown image lines from capture output back into the reply, and
   the preview URL as a bare line of its own.
```

- [ ] **Step 3: 校验文档与实现一致**

Run: `npm test`
Expected: 全绿（文档改动不影响测试，此步是防止误改源码）。

人工核对三处，它们最容易与实现脱节：
- README 的 flag 表默认值与 `cli.js` 的 `parsed.ttl ?? 30` / `parsed.grace ?? 10` / `parsed.port ?? 5173` 一致
- README 写的日志路径与 `state.tunnelLogPath(port)` 一致
- README 写的重试次数与 `startTunnel` 的 `tries = 4` 一致

- [ ] **Step 4: 提交**

```bash
git add README.md skill/SKILL.md
git commit -m "docs: record the China-network reality and the bare-link rule

The measurements are from the 2026-08-06 trial run, not estimates: one
in three establishment attempts, ~50 KB/s, and a data plane that drops
without reconnecting.

SKILL.md gains the rule that cost that session an hour — the preview link
must be emitted as a bare line, never inside a code block, because phone
clients render those unselectable."
```

---

### Task 7: 真机复验

**Files:**
- 无源码改动。若复验发现问题，回到对应任务修复。

**Interfaces:**
- Consumes: Task 1–6 的全部成果
- Produces: 无

- [ ] **Step 1: 起两个本地应用，验证并存**

```bash
node -e "require('http').createServer((_,r)=>r.end('APP A')).listen(4321,'127.0.0.1')" &
node -e "require('http').createServer((_,r)=>r.end('APP B')).listen(4322,'127.0.0.1')" &
node src/bin.js start --port 4321 --ttl 60
node src/bin.js start --port 4322 --ttl 60
node src/bin.js status
```

Expected: `status` 列出两条预览，端口分别 4321 与 4322，URL 各不相同。这是旧版做不到的——旧版第二条 `start` 会把第一条的链接交出来。

- [ ] **Step 2: 验证端口消解拒绝猜测**

```bash
node src/bin.js stop
```

Expected: 退出码 1，stderr 含 `several previews are active (ports 4321, 4322)` 与 `--port`。

- [ ] **Step 3: 验证宽限窗口**

用 `?t=` 链接连续请求两次，模拟「预取 + 人点击」：

```bash
URL=$(node -e "const s=require('fs');const p=process.env.LOCALAPPDATA+'/mobile-preview/previews/4321.json';const j=JSON.parse(s.readFileSync(p,'utf8'));console.log(j.tunnelUrl+'/?t='+j.sessionToken)")
curl -s -o /dev/null -w "first:  %{http_code}\n" "$URL"
curl -s -o /dev/null -w "second: %{http_code}\n" "$URL"
```

Expected: 两次都是 `302`。旧版第二次是 404，那正是手机上打不开的根因。

- [ ] **Step 4: 验证重试日志**

```bash
cat "$LOCALAPPDATA/mobile-preview/previews/4321.cloudflared.log" | head -5
```

Expected: 首行是 `--- attempt 1/4 ---`。若当时网络抖动导致多次尝试，前几次的失败输出应当都在，没有被覆盖。

- [ ] **Step 5: 手机端实测**

把 4321 的预览链接**以裸行形式**发给用户（不加代码块、不加反引号），请其在手机浏览器打开，确认页面可见、可交互。

Expected: 用户报告能打开。若报 404，说明宽限窗口未生效，回到 Task 4。

- [ ] **Step 6: 收尾**

```bash
node src/bin.js stop --all
node src/bin.js status
```

Expected: `status` 输出 `no active preview`，且 `previews` 目录下无残留 json。

- [ ] **Step 7: 提交复验结论**

把实测结果补进 `.superpowers/sdd/progress.md`（该目录被 `.gitignore` 全量忽略，无需 `git add`）。若复验中修了源码，按对应任务的提交规范单独提交。

---

## 附：spec 覆盖对照

| Spec 章节 | 覆盖任务 |
|---|---|
| §3 一文件一预览（含 `list()` 容错、gallery 分目录） | Task 1 |
| §4 命令面与端口消解规则 | Task 3 |
| §4.2 start 拿错端口的 bug | Task 3（`start 在别的端口有活预览时不会把那条交出去`） |
| §5 宽限窗口（含 `--grace 0`、窗口外计入限流、TTL 优先） | Task 4；`--grace` 参数在 Task 3 与 Task 2 串接 |
| §6 隧道重试与日志截断时机 | Task 5 |
| §7 README 与 SKILL.md | Task 6 |
| §8 遗留 `state.json` 迁移 | Task 2（`cleanupLegacy`）、Task 3（status/stop 调用并说明） |
| §9 非目标（不做数据面重连） | 不实现，Task 5 的提交信息中明确 |
| §10 测试策略 | Task 1–5 的 Step 1 逐条对应 |
| §11 实施顺序 | 本计划 Task 1→7 即该顺序 |
