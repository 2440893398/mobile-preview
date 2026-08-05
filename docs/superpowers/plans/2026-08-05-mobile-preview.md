# mobile-preview 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Windows 上的 Node CLI，让 AI 能把本地开发中的应用通过一条临时的、带鉴权的 Cloudflare 隧道交付到用户手机上，并把截图内联推进 Happy 对话。

**Architecture:** 一个 detached 守护进程同时持有「鉴权反代」和「cloudflared」两个部件。反代对外提供两条路径：`/_a/<capability-token>/` 服务 Playwright 产出的截图与录屏（无 Cookie，故可在 Happy 里内联渲染），`/` 反代到目标应用（`?t=` 换 HttpOnly Cookie 的会话鉴权）。守护进程自带 TTL 定时自杀，这是防止隧道残留的根本保障。

**Tech Stack:** Node 22 (ESM)、`node:test` 内置测试运行器、`node:http` 裸实现反代、Playwright、cloudflared 可执行文件。

## Global Constraints

- Node ≥ 20，ESM（`package.json` 中 `"type": "module"`）。开发机实测为 v22.19.0。
- **唯一运行时依赖是 `playwright`。** 反代、隧道管理、状态管理一律使用 Node 内置模块。理由：鉴权代码必须 fail-closed，依赖越少越易审查。
- 测试一律使用 `node:test` + `node:assert/strict`，命令 `node --test tests/`。不引入 jest/vitest。
- **一切鉴权失败返回 HTTP 404，绝不返回 401/403。** 不泄漏路径是否存在。
- token 一律 `randomBytes(32).toString('base64url')`，长度恒为 43 字符。
- **反代比对 token 时只使用 sha256 哈希**（`createProxy` 收到的是 `sessionHash`，不是明文）。state 文件为供 CLI 复用而持有明文 token —— `mp status` 与 `mp capture` 需要重新拼出可用 URL，只存哈希无法实现。缓解：该文件位于 `%LOCALAPPDATA%`（仅当前用户可读），且随 `mp stop` 或 TTL 到期删除。**token 绝不写入日志。**
- 所有对外响应带 `X-Robots-Tag: noindex, nofollow`。
- 目标平台 Windows 11。进程树终止使用 `taskkill /PID <pid> /T /F`。
- 默认 TTL 30 分钟。
- 路径黑名单（详见 Task 4）：`/@fs/`、`.env`、`.git/` 在任何模式下均阻断。

### 与设计文档的一处偏离

设计文档 5.2 节写「用 Windows Job Object 绑定子进程防孤儿」。**本计划不采用 Job Object** —— 纯 Node 创建 Job Object 需要原生扩展，与「唯一依赖 playwright」的约束冲突。替代方案由三层构成，对孤儿场景实际更可靠：

1. 守护进程自带 TTL 定时器，到期自杀并连带 `taskkill /T` 掉 cloudflared —— 即使守护进程成了孤儿，也保证在 TTL 内死亡
2. `mp stop` 主动终止进程树
3. 下一次 `mp start` 先清理 state 中记录的陈旧 pid

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | 包定义，`bin.mp` → `src/cli.js` |
| `src/state.js` | 运行态读写。只依赖 `node:fs` |
| `src/tunnel.js` | cloudflared 定位、启动、URL 解析、进程树终止 |
| `src/auth.js` | token 铸造/校验、capability 路由解析、路径黑名单。**全部是纯函数** |
| `src/proxy.js` | HTTP 请求处理：会话鉴权、限流、静态产物、反代转发 |
| `src/capture.js` | Playwright 截图/录屏、console 与失败请求采集 |
| `src/daemon.js` | 长驻进程逻辑：拉起 proxy + tunnel，TTL 到期自杀 |
| `src/daemon-entry.js` | 守护进程的可执行入口，由 `mp start` 以 detached 方式拉起 |
| `src/cli.js` | 命令实现与输出格式化。**只导出，无副作用**，以便被测试 import |
| `src/bin.js` | `mp` 命令的可执行入口，唯一职责是调用 `cli.main()` |
| `skill/SKILL.md` | 给 Claude Code / Codex 的薄包装 |
| `tests/*.test.js` | 对应单测 |

`auth.js` 从 `proxy.js` 中单独拆出，是因为鉴权判定是本项目安全性的全部所在，必须能脱离 HTTP、脱离网络、以纯函数形式被穷举测试。

---

## Task 1: 项目骨架与 state.js

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/state.js`
- Test: `tests/state.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `state.read() → object|null`、`state.write(patch) → object`、`state.clear() → void`、`state.statePath() → string`

- [ ] **Step 1: 初始化 git 仓库**

```bash
git init
git branch -M main
```

- [ ] **Step 2: 创建 package.json**

```json
{
  "name": "mobile-preview",
  "version": "0.1.0",
  "description": "Temporary authenticated preview of a local dev app, for phone-based AI workflows",
  "type": "module",
  "bin": { "mp": "./src/bin.js" },
  "scripts": { "test": "node --test tests/" },
  "engines": { "node": ">=20" },
  "dependencies": { "playwright": "^1.49.0" },
  "license": "MIT"
}
```

- [ ] **Step 3: 创建 .gitignore**

```
node_modules/
.mp-tmp/
gallery/
*.log
```

- [ ] **Step 4: 写失败的测试**

创建 `tests/state.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-state-'))
process.env.MP_STATE_DIR = dir

const { read, write, clear, statePath } = await import('../src/state.js')

test('read returns null when no state file exists', () => {
  assert.equal(read(), null)
})

test('write then read roundtrips', () => {
  write({ tunnelUrl: 'https://a.trycloudflare.com', ttl: 30 })
  assert.equal(read().tunnelUrl, 'https://a.trycloudflare.com')
  assert.equal(read().ttl, 30)
})

test('write merges into existing state rather than replacing', () => {
  write({ proxyPort: 41234 })
  const s = read()
  assert.equal(s.proxyPort, 41234)
  assert.equal(s.tunnelUrl, 'https://a.trycloudflare.com')
})

test('read returns null on corrupt json instead of throwing', () => {
  writeFileSync(statePath(), '{ not json')
  assert.equal(read(), null)
})

test('clear removes the state file', () => {
  write({ a: 1 })
  clear()
  assert.equal(read(), null)
})

test('clear is a no-op when no state file exists', () => {
  clear()
  assert.equal(read(), null)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
```

- [ ] **Step 5: 运行测试确认失败**

Run: `node --test tests/state.test.js`
Expected: FAIL —— `Cannot find module '../src/state.js'`

- [ ] **Step 6: 实现 src/state.js**

```js
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function stateDir() {
  return process.env.MP_STATE_DIR
    || join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), 'mobile-preview')
}

export function statePath() {
  return join(stateDir(), 'state.json')
}

export function read() {
  const f = statePath()
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

export function write(patch) {
  mkdirSync(stateDir(), { recursive: true })
  const next = { ...(read() || {}), ...patch }
  writeFileSync(statePath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function clear() {
  const f = statePath()
  if (existsSync(f)) rmSync(f, { force: true })
}
```

注意 `stateDir()` 写成函数而非模块级常量 —— 否则测试无法在 import 之后改写 `MP_STATE_DIR`。

- [ ] **Step 7: 运行测试确认通过**

Run: `node --test tests/state.test.js`
Expected: PASS，6 项全过

- [ ] **Step 8: 提交**

```bash
git add package.json .gitignore src/state.js tests/state.test.js
git commit -m "feat: project skeleton and state module"
```

---

## Task 2: tunnel.js —— cloudflared 生命周期

开发机上 cloudflared 尚未安装，本任务需处理获取路径。

**Files:**
- Create: `src/tunnel.js`
- Test: `tests/tunnel.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `parseTunnelUrl(text) → string|null`
  - `findCloudflared() → string|null`
  - `installHint() → string`
  - `startTunnel(localPort, {timeoutMs}) → Promise<{url, pid}>`
  - `killTree(pid) → void`（幂等：进程已死亦视为成功）
  - `isAlive(pid) → boolean`（Task 8 的 `cleanupStale` 依赖此函数）

- [ ] **Step 1: 写失败的测试**

创建 `tests/tunnel.test.js`。只测纯函数 `parseTunnelUrl` —— 启动真实隧道属于 Task 3 的冒烟验证，不适合放进单测。

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/tunnel.test.js`
Expected: FAIL —— `Cannot find module '../src/tunnel.js'`

- [ ] **Step 3: 实现 src/tunnel.js**

```js
import { spawn, execFileSync } from 'node:child_process'

const TUNNEL_URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/i

export function parseTunnelUrl(text) {
  const m = TUNNEL_URL_RE.exec(String(text))
  return m ? m[0] : null
}

export function findCloudflared() {
  try {
    const out = execFileSync('where', ['cloudflared'], { encoding: 'utf8' })
    const first = out.split(/\r?\n/).find(Boolean)
    return first ? first.trim() : null
  } catch {
    return null
  }
}

export function installHint() {
  return [
    'cloudflared not found. Install it with one of:',
    '  winget install --id Cloudflare.cloudflared',
    '  or download from https://github.com/cloudflare/cloudflared/releases',
  ].join('\n')
}

export function killTree(pid) {
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // already dead — treat as success
  }
}

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function startTunnel(localPort, { timeoutMs = 30000 } = {}) {
  const bin = findCloudflared()
  if (!bin) return Promise.reject(new Error(installHint()))

  return new Promise((resolve, reject) => {
    // --protocol http2 强制走 TCP。cloudflared 默认使用 QUIC/UDP 7844，
    // 该端口在中国大陆网络下干扰明显，隧道会反复重连。
    const child = spawn(bin, [
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
      reject(new Error(`cloudflared did not report a tunnel url within ${timeoutMs}ms`))
    }, timeoutMs)

    const onData = (d) => {
      if (settled) return
      buf += d.toString()
      const url = parseTunnelUrl(buf)
      if (!url) return
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
```

cloudflared 把 banner 写在 **stderr**，因此两个流都要监听。累积到 `buf` 而非逐块匹配，是因为 URL 可能被切分在两个 chunk 之间。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/tunnel.test.js`
Expected: PASS，5 项全过

- [ ] **Step 5: 安装 cloudflared 并人工冒烟**

```bash
winget install --id Cloudflare.cloudflared
```

新开一个终端（让 PATH 生效），运行：

```bash
node -e "import('./src/tunnel.js').then(async t => { const r = await t.startTunnel(8080); console.log(r); t.killTree(r.pid) })"
```

Expected: 打印形如 `{ url: 'https://xxx-yyy-zzz.trycloudflare.com', pid: 12345 }`

- [ ] **Step 6: 提交**

```bash
git add src/tunnel.js tests/tunnel.test.js
git commit -m "feat: cloudflared lifecycle management"
```

---

## Task 3: 🚩 可达性验证关卡（go / no-go）

**这是整个项目风险最高的假设，必须在写更多代码之前证伪或证实。**

设计基于一个观察：Happy 能渲染回复正文里的远程 markdown 图片。但验证时用的是 `placehold.co`，我们不知道 Happy 是**手机客户端直接抓图**还是**服务端代抓**。如果是前者且不经用户代理，`*.trycloudflare.com` 上的图可能加载不出来 —— 那么「内联截图」这一最优体验就不成立，只剩「发链接」。

本任务无自动化测试，产出是一个人工确认结果。

**Files:**
- Create: `scripts/probe-reachability.js`

**Interfaces:**
- Consumes: `tunnel.startTunnel`、`tunnel.killTree`
- Produces: 无代码产物。产出是记录进设计文档的一条结论。

- [ ] **Step 1: 写探针脚本**

创建 `scripts/probe-reachability.js`：

```js
import { createServer } from 'node:http'
import { startTunnel, killTree } from '../src/tunnel.js'

// 生成一张 240x80 的 PNG：纯色底 + 无文字。
// 用尺寸和颜色而非文字作为标识，避免字体渲染依赖。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAABQCAIAAAA5Z4dJAAAAT0lEQVR4nO3BMQEAAADCoPVP' +
  'bQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAADgbxIAAAHqYlPKAAAAAElFTkSuQmCC',
  'base64'
)

const server = createServer((req, res) => {
  if (req.url.startsWith('/probe.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(PNG)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<h1 style="font:700 64px sans-serif">REACHABILITY OK</h1>')
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  console.log(`local server on ${port}`)
  const { url, pid } = await startTunnel(port)
  console.log('')
  console.log('  tunnel:', url)
  console.log('  paste this line into the chat reply:')
  console.log('')
  console.log(`  ![probe](${url}/probe.png)`)
  console.log('')
  console.log('  press Ctrl+C to tear down')
  process.on('SIGINT', () => { killTree(pid); server.close(); process.exit(0) })
})
```

- [ ] **Step 2: 运行探针**

Run: `node scripts/probe-reachability.js`
Expected: 打印一条隧道 URL 和一行 markdown

- [ ] **Step 3: 把那行 markdown 贴进对话，请用户确认手机可见**

判定：

- **看得到图** → 内联截图成立，后续 Task 9 的输出契约按计划输出 markdown 图片行
- **看不到图 / 破图** → 内联截图不成立。**修改设计文档 7 节**：`mp capture` 改为输出一条指向 gallery 索引页的**链接**而非图片行，用户需点击查看。其余任务不变
- **顺带确认**：直接在手机浏览器打开隧道 URL 根路径，应看到 "REACHABILITY OK" —— 这验证的是隧道本身在用户网络下可达，与图片渲染是两件事

- [ ] **Step 4: 把结论写回设计文档**

编辑 `docs/superpowers/specs/2026-08-05-mobile-preview-design.md` 第 11 节风险表，把第一行的「待验证」替换为实际结论与日期。

- [ ] **Step 5: 提交**

```bash
git add scripts/probe-reachability.js docs/superpowers/specs/2026-08-05-mobile-preview-design.md
git commit -m "chore: reachability probe and its outcome"
```

---

## Task 4: auth.js —— 鉴权纯函数

本项目的安全性全部落在这个文件里。它不碰网络、不碰 HTTP，因此可以被穷举测试。

**Files:**
- Create: `src/auth.js`
- Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `mintToken() → string`（43 字符 base64url）
  - `hashToken(token) → string`（64 字符 hex）
  - `tokenMatches(given, hash) → boolean`
  - `parseArtifactPath(pathname) → {token, file} | null`
  - `isBlockedPath(pathname, {dev}) → boolean`
  - `readCookie(header, name) → string | null`

- [ ] **Step 1: 写失败的测试**

创建 `tests/auth.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mintToken, hashToken, tokenMatches,
  parseArtifactPath, isBlockedPath, readCookie,
} from '../src/auth.js'

test('mintToken produces 43-char base64url and is not repeatable', () => {
  const a = mintToken(), b = mintToken()
  assert.equal(a.length, 43)
  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
})

test('tokenMatches accepts the right token and rejects others', () => {
  const t = mintToken()
  const h = hashToken(t)
  assert.equal(tokenMatches(t, h), true)
  assert.equal(tokenMatches(mintToken(), h), false)
})

test('tokenMatches rejects malformed input without throwing', () => {
  const h = hashToken(mintToken())
  assert.equal(tokenMatches('', h), false)
  assert.equal(tokenMatches('short', h), false)
  assert.equal(tokenMatches(null, h), false)
  assert.equal(tokenMatches('x'.repeat(43), 'not-a-hash'), false)
})

test('parseArtifactPath extracts token and filename', () => {
  const t = mintToken()
  assert.deepEqual(parseArtifactPath(`/_a/${t}/shot-1.png`), { token: t, file: 'shot-1.png' })
})

test('parseArtifactPath rejects traversal and nesting', () => {
  const t = mintToken()
  assert.equal(parseArtifactPath(`/_a/${t}/../state.json`), null)
  assert.equal(parseArtifactPath(`/_a/${t}/sub/shot.png`), null)
  assert.equal(parseArtifactPath(`/_a/${t}/`), null)
  assert.equal(parseArtifactPath('/_a/tooshort/shot.png'), null)
  assert.equal(parseArtifactPath('/shot-1.png'), null)
})

test('always-blocked paths are blocked in both modes', () => {
  for (const dev of [false, true]) {
    assert.equal(isBlockedPath('/@fs/C:/Users/me/.ssh/id_rsa', { dev }), true, `@fs dev=${dev}`)
    assert.equal(isBlockedPath('/.env', { dev }), true, `.env dev=${dev}`)
    assert.equal(isBlockedPath('/.env.local', { dev }), true, `.env.local dev=${dev}`)
    assert.equal(isBlockedPath('/app/.env', { dev }), true, `nested .env dev=${dev}`)
    assert.equal(isBlockedPath('/.git/config', { dev }), true, `.git dev=${dev}`)
  }
})

test('dev-only paths are blocked by default and allowed with dev', () => {
  const paths = ['/@vite/client', '/@id/foo', '/node_modules/vite/x.js', '/assets/app.js.map']
  for (const p of paths) {
    assert.equal(isBlockedPath(p, { dev: false }), true, `${p} should be blocked by default`)
    assert.equal(isBlockedPath(p, { dev: true }), false, `${p} should be allowed in dev`)
  }
})

test('ordinary paths are never blocked', () => {
  for (const dev of [false, true]) {
    assert.equal(isBlockedPath('/', { dev }), false)
    assert.equal(isBlockedPath('/index.html', { dev }), false)
    assert.equal(isBlockedPath('/assets/app-a1b2.js', { dev }), false)
    assert.equal(isBlockedPath('/api/users', { dev }), false)
  }
})

test('readCookie finds a named cookie among several', () => {
  assert.equal(readCookie('a=1; mp_session=abc123; b=2', 'mp_session'), 'abc123')
  assert.equal(readCookie('mp_session=solo', 'mp_session'), 'solo')
  assert.equal(readCookie('other=1', 'mp_session'), null)
  assert.equal(readCookie(undefined, 'mp_session'), null)
})

test('readCookie does not match a name that is a suffix of another', () => {
  assert.equal(readCookie('xmp_session=wrong', 'mp_session'), null)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/auth.test.js`
Expected: FAIL —— `Cannot find module '../src/auth.js'`

- [ ] **Step 3: 实现 src/auth.js**

```js
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

// 任何模式下都阻断。/@fs/ 是 2025 年一系列 Vite 任意文件读取 CVE 的入口，
// .env 与 .git 从无任何预览场景需要。
const ALWAYS_BLOCKED = [
  /\/@fs\//,
  /(^|\/)\.env/,
  /(^|\/)\.git(\/|$)/,
]

// 仅 dev server 需要，构建产物模式下一律阻断。
const DEV_ONLY = [
  /\/@vite\//,
  /\/@id\//,
  /(^|\/)node_modules(\/|$)/,
  /\.map$/,
]

export function mintToken() {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function tokenMatches(given, hash) {
  if (typeof given !== 'string' || !TOKEN_RE.test(given)) return false
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return false
  const a = Buffer.from(hashToken(given), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function parseArtifactPath(pathname) {
  const m = /^\/_a\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(pathname)
  if (!m) return null
  return { token: m[1], file: m[2] }
}

export function isBlockedPath(pathname, { dev = false } = {}) {
  const p = String(pathname)
  if (ALWAYS_BLOCKED.some((re) => re.test(p))) return true
  if (!dev && DEV_ONLY.some((re) => re.test(p))) return true
  return false
}

export function readCookie(header, name) {
  if (!header) return null
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}
```

文件名正则 `[A-Za-z0-9][A-Za-z0-9._-]*` 不含 `/`，因此 `../` 无法匹配 —— 路径穿越在解析层就被挡住，不依赖后续的路径规范化。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/auth.test.js`
Expected: PASS，10 项全过

- [ ] **Step 5: 提交**

```bash
git add src/auth.js tests/auth.test.js
git commit -m "feat: authentication primitives and path blocklist"
```

---

## Task 5: proxy.js —— 静态产物与会话鉴权

**Files:**
- Create: `src/proxy.js`
- Test: `tests/proxy.test.js`

**Interfaces:**
- Consumes: `auth.js` 全部导出、`state.js` 无
- Produces: `createProxy({galleryDir, galleryToken, sessionHash, expiresAt, dev, targetPort}) → http.Server`，该 server 尚未 listen；调用方自行 `listen(0)`。

本任务只实现 `/_a/` 与会话鉴权，反代转发留到 Task 6（此时 `/` 命中鉴权后返回 502）。

- [ ] **Step 1: 写失败的测试**

创建 `tests/proxy.test.js`：

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProxy } from '../src/proxy.js'
import { mintToken, hashToken } from '../src/auth.js'

const galleryDir = mkdtempSync(join(tmpdir(), 'mp-gallery-'))
writeFileSync(join(galleryDir, 'shot-1.png'), 'PNGDATA')

const galleryToken = mintToken()
const sessionToken = mintToken()

let server, base

before(async () => {
  server = createProxy({
    galleryDir,
    galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev: false,
    targetPort: 1,           // 无人监听，用于断言 502
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  rmSync(galleryDir, { recursive: true, force: true })
})

test('artifact served without any cookie', async () => {
  const res = await fetch(`${base}/_a/${galleryToken}/shot-1.png`, { redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('set-cookie'), null, 'artifact route must not set cookies')
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal(await res.text(), 'PNGDATA')
})

test('artifact with wrong gallery token is 404', async () => {
  const res = await fetch(`${base}/_a/${mintToken()}/shot-1.png`)
  assert.equal(res.status, 404)
})

test('artifact that does not exist on disk is 404', async () => {
  const res = await fetch(`${base}/_a/${galleryToken}/missing.png`)
  assert.equal(res.status, 404)
})

test('app root without token is 404, not 401 or 403', async () => {
  const res = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(res.status, 404)
})

test('app root with wrong token is 404', async () => {
  const res = await fetch(`${base}/?t=${mintToken()}`, { redirect: 'manual' })
  assert.equal(res.status, 404)
})

test('correct token sets an HttpOnly cookie and redirects to the clean path', async () => {
  const res = await fetch(`${base}/?t=${sessionToken}`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/')
  const cookie = res.headers.get('set-cookie')
  assert.match(cookie, /^mp_session=/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Secure/)
})

test('a valid session cookie reaches the target and surfaces 502 when it is down', async () => {
  const res = await fetch(`${base}/`, {
    headers: { cookie: `mp_session=${sessionToken}` },
    redirect: 'manual',
  })
  assert.equal(res.status, 502)
})

test('blocked paths are 404 even with a valid session', async () => {
  for (const p of ['/@fs/C:/x', '/.env', '/@vite/client']) {
    const res = await fetch(`${base}${p}`, { headers: { cookie: `mp_session=${sessionToken}` } })
    assert.equal(res.status, 404, `${p} must be blocked`)
  }
})

test('an expired session is 404', async () => {
  const expired = createProxy({
    galleryDir, galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() - 1,
    dev: false, targetPort: 1,
  })
  await new Promise((r) => expired.listen(0, '127.0.0.1', r))
  const b = `http://127.0.0.1:${expired.address().port}`
  const res = await fetch(`${b}/`, { headers: { cookie: `mp_session=${sessionToken}` } })
  assert.equal(res.status, 404)
  const art = await fetch(`${b}/_a/${galleryToken}/shot-1.png`)
  assert.equal(art.status, 404, 'expiry must also kill artifact access')
  expired.close()
})

test('repeated bad tokens trip the rate limiter', async () => {
  const rl = createProxy({
    galleryDir, galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev: false, targetPort: 1, maxFailures: 3,
  })
  await new Promise((r) => rl.listen(0, '127.0.0.1', r))
  const b = `http://127.0.0.1:${rl.address().port}`
  for (let i = 0; i < 3; i++) await fetch(`${b}/?t=${mintToken()}`)
  // 限流生效后，即便是正确的 token 也不再被接受
  const res = await fetch(`${b}/?t=${sessionToken}`, { redirect: 'manual' })
  assert.equal(res.status, 404)
  rl.close()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/proxy.test.js`
Expected: FAIL —— `Cannot find module '../src/proxy.js'`

- [ ] **Step 3: 实现 src/proxy.js**

```js
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArtifactPath, isBlockedPath, tokenMatches, readCookie, hashToken } from './auth.js'

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.html': 'text/html; charset=utf-8',
}

function mimeFor(file) {
  const dot = file.lastIndexOf('.')
  return MIME[file.slice(dot).toLowerCase()] || 'application/octet-stream'
}

function notFound(res) {
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
  })
  res.end('Not Found')
}

export function createProxy({
  galleryDir,
  galleryToken,
  sessionHash,
  expiresAt,
  dev = false,
  targetPort,
  maxFailures = 10,
  failureWindowMs = 5 * 60_000,
}) {
  const galleryHash = hashToken(galleryToken)
  const failures = new Map() // ip -> { count, resetAt }

  function tripped(ip) {
    const f = failures.get(ip)
    if (!f) return false
    if (Date.now() > f.resetAt) { failures.delete(ip); return false }
    return f.count >= maxFailures
  }

  function recordFailure(ip) {
    const now = Date.now()
    const f = failures.get(ip)
    if (!f || now > f.resetAt) {
      failures.set(ip, { count: 1, resetAt: now + failureWindowMs })
    } else {
      f.count += 1
    }
  }

  const server = createServer((req, res) => {
    const ip = req.socket.remoteAddress || 'unknown'
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname

    if (Date.now() > expiresAt) return notFound(res)
    if (tripped(ip)) return notFound(res)

    // --- capability 路由：无 Cookie，供 Happy 内联渲染 ---
    const art = parseArtifactPath(pathname)
    if (art) {
      if (!tokenMatches(art.token, galleryHash)) {
        recordFailure(ip)
        return notFound(res)
      }
      const file = join(galleryDir, art.file)
      if (!existsSync(file) || !statSync(file).isFile()) return notFound(res)
      res.writeHead(200, {
        'Content-Type': mimeFor(art.file),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      })
      return createReadStream(file).pipe(res)
    }

    if (isBlockedPath(pathname, { dev })) return notFound(res)

    // --- 会话鉴权 ---
    const qs = url.searchParams.get('t')
    if (qs) {
      if (!tokenMatches(qs, sessionHash)) {
        recordFailure(ip)
        return notFound(res)
      }
      const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      url.searchParams.delete('t')
      const clean = pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '')
      res.writeHead(302, {
        'Location': clean,
        'Set-Cookie': `mp_session=${qs}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
        'X-Robots-Tag': 'noindex, nofollow',
      })
      return res.end()
    }

    const cookie = readCookie(req.headers.cookie, 'mp_session')
    if (!tokenMatches(cookie, sessionHash)) {
      if (cookie) recordFailure(ip)
      return notFound(res)
    }

    forward(req, res, { targetPort, dev })
  })

  return server
}

// Task 6 替换此实现
function forward(req, res, _opts) {
  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Bad Gateway')
}
```

要点：**产物路由的过期判定与会话共用同一个 `expiresAt`**，因此隧道到期后截图链接一并失效，不会留下长期可访问的公开图片。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/proxy.test.js`
Expected: PASS，10 项全过

- [ ] **Step 5: 提交**

```bash
git add src/proxy.js tests/proxy.test.js
git commit -m "feat: proxy with capability artifacts and session auth"
```

---

## Task 6: proxy.js —— 反代转发与 Host 重写

**Files:**
- Modify: `src/proxy.js`（替换 `forward` 函数）
- Test: `tests/forward.test.js`

**Interfaces:**
- Consumes: Task 5 的 `createProxy`
- Produces: 无新导出。`forward` 由 502 桩替换为真实转发。

- [ ] **Step 1: 写失败的测试**

创建 `tests/forward.test.js`：

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProxy } from '../src/proxy.js'
import { mintToken, hashToken } from '../src/auth.js'

const galleryDir = mkdtempSync(join(tmpdir(), 'mp-fwd-'))
const sessionToken = mintToken()
let target, targetPort, seenHost, seenBody

before(async () => {
  target = createServer((req, res) => {
    seenHost = req.headers.host
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seenBody = body
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-From': 'target' })
      res.end(`${req.method} ${req.url}`)
    })
  })
  await new Promise((r) => target.listen(0, '127.0.0.1', r))
  targetPort = target.address().port
})

after(() => { target.close(); rmSync(galleryDir, { recursive: true, force: true }) })

function proxyFor(dev) {
  const s = createProxy({
    galleryDir, galleryToken: mintToken(),
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev, targetPort,
  })
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)))
}

test('GET is forwarded with path preserved and response passed back', async () => {
  const s = await proxyFor(false)
  const b = `http://127.0.0.1:${s.address().port}`
  const res = await fetch(`${b}/hello/world?a=1`, { headers: { cookie: `mp_session=${sessionToken}` } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-from'), 'target')
  assert.equal(await res.text(), 'GET /hello/world?a=1')
  s.close()
})

test('POST body is forwarded intact', async () => {
  const s = await proxyFor(false)
  const b = `http://127.0.0.1:${s.address().port}`
  await fetch(`${b}/api`, {
    method: 'POST',
    headers: { cookie: `mp_session=${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hi: 1 }),
  })
  assert.equal(seenBody, '{"hi":1}')
  s.close()
})

test('dev mode rewrites Host to localhost so vite allowedHosts passes', async () => {
  const s = await proxyFor(true)
  const b = `http://127.0.0.1:${s.address().port}`
  await fetch(`${b}/`, { headers: { cookie: `mp_session=${sessionToken}` } })
  assert.equal(seenHost, `localhost:${targetPort}`)
  s.close()
})

test('non-dev mode also normalises Host to the target', async () => {
  const s = await proxyFor(false)
  const b = `http://127.0.0.1:${s.address().port}`
  await fetch(`${b}/`, { headers: { cookie: `mp_session=${sessionToken}` } })
  assert.equal(seenHost, `localhost:${targetPort}`)
  s.close()
})

test('the session cookie is not leaked to the target application', async () => {
  const s = await proxyFor(false)
  const b = `http://127.0.0.1:${s.address().port}`
  let sawCookie = 'unset'
  const sniff = createServer((req, res) => {
    sawCookie = req.headers.cookie ?? null
    res.end('ok')
  })
  await new Promise((r) => sniff.listen(0, '127.0.0.1', r))
  const s2 = createProxy({
    galleryDir, galleryToken: mintToken(),
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev: false, targetPort: sniff.address().port,
  })
  await new Promise((r) => s2.listen(0, '127.0.0.1', r))
  await fetch(`http://127.0.0.1:${s2.address().port}/`, {
    headers: { cookie: `mp_session=${sessionToken}; app_pref=dark` },
  })
  assert.equal(sawCookie, 'app_pref=dark', 'mp_session must be stripped, other cookies kept')
  s.close(); s2.close(); sniff.close()
})

test('a dead target yields 502 rather than a hang', async () => {
  const s = createProxy({
    galleryDir, galleryToken: mintToken(),
    sessionHash: hashToken(sessionToken),
    expiresAt: Date.now() + 60_000,
    dev: false, targetPort: 1,
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const res = await fetch(`http://127.0.0.1:${s.address().port}/`, {
    headers: { cookie: `mp_session=${sessionToken}` },
  })
  assert.equal(res.status, 502)
  s.close()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/forward.test.js`
Expected: FAIL —— 转发用例得到 502

- [ ] **Step 3: 替换 forward 实现**

在 `src/proxy.js` 顶部加入 import：

```js
import { request as httpRequest } from 'node:http'
```

把文件末尾的 `forward` 桩替换为：

```js
function stripSessionCookie(header) {
  if (!header) return undefined
  const kept = String(header)
    .split(';')
    .map((p) => p.trim())
    .filter((p) => !p.startsWith('mp_session='))
  return kept.length ? kept.join('; ') : undefined
}

function forward(req, res, { targetPort }) {
  const headers = { ...req.headers }

  // Host 重写：让目标看到的是 localhost，从而通过 Vite 的 allowedHosts
  // 与 Next.js 的 allowedDevOrigins 校验，无需改用户配置。
  headers.host = `localhost:${targetPort}`

  // 会话 Cookie 是本工具的凭证，不该泄漏给被预览的应用。
  const cookie = stripSessionCookie(req.headers.cookie)
  if (cookie) headers.cookie = cookie
  else delete headers.cookie

  delete headers['accept-encoding'] // 不做解压，直接透传原始字节

  const upstream = httpRequest(
    { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode, { ...up.headers, 'X-Robots-Tag': 'noindex, nofollow' })
      up.pipe(res)
    }
  )

  upstream.on('error', () => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Bad Gateway')
  })

  req.pipe(upstream)
}
```

- [ ] **Step 4: 运行全部测试确认通过**

Run: `node --test tests/`
Expected: PASS，此前所有用例加本任务 6 项全过

- [ ] **Step 5: 提交**

```bash
git add src/proxy.js tests/forward.test.js
git commit -m "feat: reverse proxy forwarding with host rewrite and cookie stripping"
```

---

## Task 7: capture.js —— Playwright 采集

**Files:**
- Create: `src/capture.js`
- Test: `tests/capture.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `capture({url, outDir, steps, video, deviceName}) → Promise<{shots: string[], video: string|null, consoleErrors: string[], failedRequests: object[]}>`。`shots` 与 `video` 是文件的**基名**（非完整路径），因为调用方要用它们拼 URL。

- [ ] **Step 1: 安装 Playwright 浏览器**

```bash
npm install
npx playwright install chromium
```

- [ ] **Step 2: 写失败的测试**

创建 `tests/capture.test.js`：

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture } from '../src/capture.js'

let server, base, outDir

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/broken.js') {
      res.writeHead(500, { 'Content-Type': 'application/javascript' })
      return res.end('boom')
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset=utf-8>
      <h1 id=t>capture target</h1>
      <script>console.error('deliberate console error')</script>
      <script src="/broken.js"></script>`)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  outDir = mkdtempSync(join(tmpdir(), 'mp-cap-'))
})

after(() => { server.close(); rmSync(outDir, { recursive: true, force: true }) })

test('produces a screenshot file and reports its basename', async () => {
  const r = await capture({ url: base, outDir })
  assert.equal(r.shots.length, 1)
  assert.equal(r.shots[0], 'shot-1.png')
  assert.ok(existsSync(join(outDir, 'shot-1.png')), 'screenshot must exist on disk')
})

test('collects console errors for the agent to self-check', async () => {
  const r = await capture({ url: base, outDir })
  assert.ok(
    r.consoleErrors.some((e) => e.includes('deliberate console error')),
    `expected the console error, got ${JSON.stringify(r.consoleErrors)}`
  )
})

test('collects failing network responses', async () => {
  const r = await capture({ url: base, outDir })
  assert.ok(
    r.failedRequests.some((f) => f.url.endsWith('/broken.js') && f.status === 500),
    `expected the 500, got ${JSON.stringify(r.failedRequests)}`
  )
})

test('records a video when asked', async () => {
  const r = await capture({ url: base, outDir, video: true })
  assert.ok(r.video, 'video basename must be reported')
  assert.ok(existsSync(join(outDir, r.video)), 'video must exist on disk')
})

test('an unreachable url rejects rather than returning an empty result', async () => {
  await assert.rejects(() => capture({ url: 'http://127.0.0.1:1', outDir }))
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test tests/capture.test.js`
Expected: FAIL —— `Cannot find module '../src/capture.js'`

- [ ] **Step 4: 实现 src/capture.js**

```js
import { chromium, devices } from 'playwright'
import { renameSync } from 'node:fs'
import { join, basename } from 'node:path'

export async function capture({
  url,
  outDir,
  steps = null,
  video = false,
  deviceName = 'iPhone 13',
}) {
  const device = devices[deviceName] || devices['iPhone 13']
  const browser = await chromium.launch()
  const context = await browser.newContext({
    ...device,
    recordVideo: video ? { dir: outDir, size: device.viewport } : undefined,
  })
  const page = await context.newPage()

  const consoleErrors = []
  const failedRequests = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), error: req.failure()?.errorText ?? 'failed' })
  })
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push({ url: res.url(), status: res.status() })
  })

  const shots = []
  const videoHandle = video ? page.video() : null
  let failure = null

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
    await page.waitForTimeout(500) // 让首屏动画与延迟渲染落定

    if (typeof steps === 'function') await steps(page)

    const name = 'shot-1.png'
    await page.screenshot({ path: join(outDir, name), fullPage: false })
    shots.push(name)
  } catch (err) {
    failure = err
  }

  // context 必须先于 browser 关闭，否则 Playwright 不会把视频 flush 到磁盘
  await context.close()
  await browser.close()

  if (failure) throw failure

  let videoName = null
  if (videoHandle) {
    const produced = await videoHandle.path()
    const target = join(outDir, 'reel.webm')
    renameSync(produced, target)
    videoName = basename(target)
  }

  return { shots, video: videoName, consoleErrors, failedRequests }
}
```

**不要把清理写进 `finally` 再从中 `return`** —— `finally` 里的 `return` 会吞掉待抛出的异常，导致目标不可达时函数静默返回空结果，恰好绕过本任务最后一条断言。这里改用 `failure` 变量承接异常，清理完毕后再重抛。

`page.video()` 必须在 `context.close()` **之前**取得句柄，关闭之后 page 已失效。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/capture.test.js`
Expected: PASS，5 项全过。首次运行可能较慢（浏览器冷启动）。

- [ ] **Step 6: 提交**

```bash
git add src/capture.js tests/capture.test.js package-lock.json
git commit -m "feat: playwright capture with console and network diagnostics"
```

---

## Task 8: daemon.js —— 长驻进程与 TTL 自杀

**Files:**
- Create: `src/daemon.js`
- Test: `tests/daemon.test.js`

**Interfaces:**
- Consumes: `proxy.createProxy`、`tunnel.startTunnel`、`tunnel.killTree`、`tunnel.isAlive`、`state.write`、`state.read`、`state.clear`
- Produces:
  - `runDaemon({targetPort, dev, ttlMinutes, galleryDir}) → Promise<void>`（不返回，直到自杀）
  - `cleanupStale() → {killed: number}`

守护进程由 `mp start` 以 detached 方式拉起。它写 state，CLI 轮询 state 直到出现 `tunnelUrl`。

- [ ] **Step 1: 写失败的测试**

创建 `tests/daemon.test.js`。只测 `cleanupStale` —— 完整守护进程需要真实 cloudflared，归入 Task 10 的端到端。

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-daemon-'))
process.env.MP_STATE_DIR = dir

const state = await import('../src/state.js')
const { cleanupStale } = await import('../src/daemon.js')

test('cleanupStale is a no-op when there is no state', () => {
  state.clear()
  assert.deepEqual(cleanupStale(), { killed: 0 })
})

test('cleanupStale clears state referencing dead pids', () => {
  // pid belonging to nothing: use a very high pid that will not exist
  state.write({ tunnelPid: 999_999, daemonPid: 999_998, tunnelUrl: 'https://x.trycloudflare.com' })
  const r = cleanupStale()
  assert.equal(r.killed, 0, 'dead pids need no killing')
  assert.equal(state.read(), null, 'state must be wiped')
})

test('cleanupStale removes state whose expiry has passed', () => {
  state.write({ expiresAt: Date.now() - 1000, tunnelUrl: 'https://y.trycloudflare.com' })
  cleanupStale()
  assert.equal(state.read(), null)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/daemon.test.js`
Expected: FAIL —— `Cannot find module '../src/daemon.js'`

- [ ] **Step 3: 实现 src/daemon.js**

```js
import { mkdirSync } from 'node:fs'
import { createProxy } from './proxy.js'
import { startTunnel, killTree, isAlive } from './tunnel.js'
import { mintToken, hashToken } from './auth.js'
import * as state from './state.js'

export function cleanupStale() {
  const s = state.read()
  if (!s) return { killed: 0 }

  let killed = 0
  for (const pid of [s.tunnelPid, s.daemonPid]) {
    if (pid && isAlive(pid)) { killTree(pid); killed += 1 }
  }
  state.clear()
  return { killed }
}

export async function runDaemon({ targetPort, dev = false, ttlMinutes = 30, galleryDir }) {
  mkdirSync(galleryDir, { recursive: true })

  const galleryToken = mintToken()
  const sessionToken = mintToken()
  const expiresAt = Date.now() + ttlMinutes * 60_000

  const proxy = createProxy({
    galleryDir, galleryToken,
    sessionHash: hashToken(sessionToken),
    expiresAt, dev, targetPort,
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  const proxyPort = proxy.address().port

  let tunnelPid = null
  try {
    const t = await startTunnel(proxyPort)
    tunnelPid = t.pid
    state.write({
      tunnelUrl: t.url,
      tunnelPid,
      daemonPid: process.pid,
      proxyPort,
      targetPort,
      dev,
      expiresAt,
      galleryDir,
      galleryToken,      // CLI 需要它来拼产物 URL；随 state 一同在 stop 时销毁
      sessionToken,      // 同上，仅用于 CLI 打印一次
      artifacts: [],
    })
  } catch (err) {
    // 隧道起不来：回收反代，写下错误供 CLI 读取，然后退出。不留残余。
    proxy.close()
    state.write({ error: String(err.message || err), daemonPid: process.pid })
    process.exit(1)
  }

  const shutdown = () => {
    killTree(tunnelPid)
    proxy.close()
    state.clear()
    process.exit(0)
  }

  // TTL 自杀是防孤儿的根本保障：即使守护进程失去父进程，
  // 也保证隧道在 TTL 内消失。
  setTimeout(shutdown, Math.max(0, expiresAt - Date.now())).unref?.()
  setInterval(() => {
    if (Date.now() > expiresAt) shutdown()
  }, 15_000)

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
```

`sessionToken` 与 `galleryToken` 以明文存在 state 中，这是 Global Constraints 已经写明并接受的取舍：反代比对只用 `sessionHash`，明文仅供 CLI 复用以拼出可用 URL，文件随会话销毁。**不要把 token 写进任何日志或 console 之外的输出。**

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/daemon.test.js`
Expected: PASS，3 项全过

- [ ] **Step 5: 同步设计文档**

在 `docs/superpowers/specs/2026-08-05-mobile-preview-design.md` 的 4.1 节安全细则中，把

> - token 只出现在 CLI 标准输出，**不写日志、不写 state 文件明文**（state 里只存哈希）

改为

> - 反代比对 token 只使用 sha256 哈希。state 文件为供 CLI 复用而持有明文 token，位于 `%LOCALAPPDATA%` 且随 `mp stop` 或 TTL 到期删除。token 绝不写入日志。

（本计划的 Global Constraints 已先行修正为同一表述。）

- [ ] **Step 6: 提交**

```bash
git add src/daemon.js tests/daemon.test.js docs/superpowers/
git commit -m "feat: daemon with ttl self-termination and stale cleanup"
```

---

## Task 9: cli.js —— 命令面与输出契约

**Files:**
- Create: `src/cli.js`
- Test: `tests/cli.test.js`

**Interfaces:**
- Consumes: `daemon.cleanupStale`、`daemon.runDaemon`、`capture.capture`、`state.*`
- Produces:
  - `formatCapture({tunnelUrl, galleryToken, shots, video, consoleErrors, failedRequests}) → string`（纯函数）
  - `formatStart({tunnelUrl, sessionToken, expiresAt, dev}) → string`（纯函数）
  - `main(argv) → Promise<void>`
  - 可执行命令 `mp start|status|stop|capture`（经 `src/bin.js`）

- [ ] **Step 1: 写失败的测试**

创建 `tests/cli.test.js`。只测输出格式化 —— 这是 AI 消费的契约，必须精确。

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCapture, formatStart } from '../src/cli.js'

const URL_ = 'https://tidy-pear.trycloudflare.com'
const TOK = 'a'.repeat(43)

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
    shots: [], video: 'reel.webm',
    consoleErrors: [], failedRequests: [],
  })
  assert.ok(out.includes(`[reel.webm](${URL_}/_a/${TOK}/reel.webm)`), out)
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/cli.test.js`
Expected: FAIL —— `Cannot find module '../src/cli.js'`

- [ ] **Step 3: 实现 src/cli.js**

```js
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createConnection } from 'node:net'
import * as state from './state.js'
import { cleanupStale, runDaemon } from './daemon.js'
import { capture } from './capture.js'

const HERE = dirname(fileURLToPath(import.meta.url))

export function formatCapture({ tunnelUrl, galleryToken, shots, video, consoleErrors, failedRequests }) {
  const lines = []
  const base = `${tunnelUrl}/_a/${galleryToken}`

  for (const s of shots) {
    const alt = s.replace(/\.[^.]+$/, '')
    lines.push(`![${alt}](${base}/${s})`)
  }
  if (video) lines.push(`[${video}](${base}/${video})`)

  lines.push('')
  if (consoleErrors.length === 0 && failedRequests.length === 0) {
    lines.push('Page loaded clean: no console errors, no failed requests.')
  } else {
    if (consoleErrors.length) {
      lines.push(`CONSOLE ERRORS (${consoleErrors.length}):`)
      for (const e of consoleErrors) lines.push(`  - ${e}`)
    }
    if (failedRequests.length) {
      lines.push(`FAILED REQUESTS (${failedRequests.length}):`)
      for (const f of failedRequests) lines.push(`  - ${f.status ?? f.error} ${f.url}`)
    }
  }
  return lines.join('\n')
}

export function formatStart({ tunnelUrl, sessionToken, expiresAt, dev }) {
  const mins = Math.round((expiresAt - Date.now()) / 60_000)
  const lines = [
    `preview: ${tunnelUrl}/?t=${sessionToken}`,
    `expires in ${mins} min`,
  ]
  if (dev) {
    lines.push('dev mode: dev server exposed. HMR is not guaranteed over the tunnel.')
  }
  return lines.join('\n')
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    const done = (ok) => { sock.destroy(); resolve(ok) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    setTimeout(() => done(false), 1500)
  })
}

async function waitForState(predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = state.read()
    if (s && predicate(s)) return s
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

async function cmdStart(args) {
  const port = Number(argOf(args, '--port') ?? 5173)
  const dev = args.includes('--dev')
  const ttl = Number(argOf(args, '--ttl') ?? 30)

  const existing = state.read()
  if (existing?.tunnelUrl && Date.now() < existing.expiresAt) {
    console.log(formatStart(startView(existing)))
    return
  }
  cleanupStale()

  if (!(await portIsOpen(port))) {
    console.error(`nothing is listening on 127.0.0.1:${port}. Start your app first.`)
    process.exit(1)
  }

  const galleryDir = join(process.env.LOCALAPPDATA || process.cwd(), 'mobile-preview', 'gallery')
  const child = spawn(process.execPath, [
    join(HERE, 'daemon-entry.js'),
    String(port), String(dev), String(ttl), galleryDir,
  ], { detached: true, stdio: 'ignore' })
  child.unref()

  const s = await waitForState((x) => x.tunnelUrl || x.error)
  if (!s) { console.error('timed out waiting for the tunnel'); process.exit(1) }
  if (s.error) { console.error(s.error); state.clear(); process.exit(1) }

  console.log(formatStart(startView(s)))
}

function startView(s) {
  return { tunnelUrl: s.tunnelUrl, sessionToken: s.sessionToken, expiresAt: s.expiresAt, dev: s.dev }
}

async function cmdCapture(args) {
  const s = state.read()
  if (!s?.tunnelUrl) { console.error('no active preview. Run `mp start` first.'); process.exit(1) }

  const url = args.find((a) => !a.startsWith('--')) || `http://127.0.0.1:${s.targetPort}/`
  const video = args.includes('--video')

  const r = await capture({ url, outDir: s.galleryDir, video })
  state.write({ artifacts: [...(s.artifacts || []), ...r.shots, r.video].filter(Boolean) })

  console.log(formatCapture({
    tunnelUrl: s.tunnelUrl, galleryToken: s.galleryToken,
    shots: r.shots, video: r.video,
    consoleErrors: r.consoleErrors, failedRequests: r.failedRequests,
  }))
}

function cmdStatus() {
  const s = state.read()
  if (!s) { console.log('no active preview'); return }
  if (Date.now() > s.expiresAt) {
    console.log('previous preview has expired; cleaning up')
    cleanupStale()
    return
  }
  console.log(formatStart(startView(s)))
  console.log(`artifacts: ${(s.artifacts || []).length}`)
}

function cmdStop() {
  const r = cleanupStale()
  console.log(`stopped (${r.killed} process tree(s) terminated)`)
}

function argOf(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

export async function main(argv) {
  const [cmd, ...rest] = argv
  const table = { start: cmdStart, capture: cmdCapture, status: cmdStatus, stop: cmdStop }
  const fn = table[cmd]
  if (!fn) {
    console.error('usage: mp <start|capture|status|stop>')
    process.exit(1)
  }
  await fn(rest)
}
```

**注意 `cli.js` 没有 shebang，也不做任何模块级的命令分发。** 它只导出纯函数和 `main`。执行入口是下一步的 `bin.js`。这样 `tests/cli.test.js` 可以安全地 import 它而不触发任何副作用 —— 若把分发写在模块顶层，import 会直接 `process.exit(1)`，测试根本跑不起来。

- [ ] **Step 3b: 创建可执行入口 src/bin.js**

```js
#!/usr/bin/env node
import { main } from './cli.js'
await main(process.argv.slice(2))
```

同时把 `package.json` 的 bin 指向它：

```json
  "bin": { "mp": "./src/bin.js" },
```

- [ ] **Step 4: 创建守护进程入口 src/daemon-entry.js**

守护进程需要一个独立入口，否则 detached 子进程会重新执行 CLI 的命令分发。

```js
import { runDaemon } from './daemon.js'

const [port, dev, ttl, galleryDir] = process.argv.slice(2)
await runDaemon({
  targetPort: Number(port),
  dev: dev === 'true',
  ttlMinutes: Number(ttl),
  galleryDir,
})
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/cli.test.js`
Expected: PASS，6 项全过

- [ ] **Step 6: 运行全部测试**

Run: `node --test tests/`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add src/cli.js src/bin.js src/daemon-entry.js tests/cli.test.js package.json
git commit -m "feat: cli commands and agent-facing output contract"
```

---

## Task 10: SKILL.md 与端到端验证

**Files:**
- Create: `skill/SKILL.md`
- Create: `README.md`

**Interfaces:**
- Consumes: 全部
- Produces: 无代码

- [ ] **Step 1: 写 skill/SKILL.md**

```markdown
---
name: mobile-preview
description: Use when the user is on a phone and needs to see a locally-running web app — creates a temporary authenticated tunnel and posts screenshots inline into the conversation.
---

# mobile-preview

用户通过手机远程操作本机，看不到屏幕。本技能把本地跑着的应用交付到用户眼前。

## 何时使用

- 你刚改完前端代码，需要用户确认效果
- 用户问「现在长什么样」「能看看吗」
- 你需要在交付前自己确认页面没白屏

## 流程

1. 确认目标应用已在跑。**优先跑构建产物**（`npm run build && npm run preview`），而不是 dev server —— 攻击面小得多。
2. `mp start --port <端口>`（dev server 才加 `--dev`）
3. `mp capture`（要录屏加 `--video`）
4. **先读 capture 的输出**。若有 CONSOLE ERRORS 或 FAILED REQUESTS，先修，别把坏页面交给用户。
5. 干净后，把 capture 输出的 markdown 图片行**原样粘贴**进你的回复，并附上 `mp start` 给出的链接。
6. 用户看完后 `mp stop`。

## 铁律

- **绝不**把 `--port` 指向 Happy、Claude Code、Codex、终端或任何非目标应用的端口
- 图片行必须原样复制，不要自己拼 URL
- 默认 30 分钟过期。用户还要看就 `mp start` 重开，不要延长
- 交付前必须自己看一眼截图
```

- [ ] **Step 2: 写 README.md**

```markdown
# mobile-preview

Temporary, authenticated preview of a locally-running app — built for driving
an AI coding agent from a phone.

## Install

    npm install
    npx playwright install chromium
    winget install --id Cloudflare.cloudflared
    npm link

## Use

    npm run build && npm run preview     # in your project
    mp start --port 4173
    mp capture
    mp stop

## Design

See `docs/superpowers/specs/2026-08-05-mobile-preview-design.md`.

## Security

- Everything behind the tunnel requires a 32-byte token
- All auth failures return 404, never 403
- `/@fs/`, `.env`, `.git/` are blocked in every mode
- The session cookie is stripped before requests reach your app
- The daemon self-terminates at TTL, so an orphaned tunnel still dies
```

- [ ] **Step 3: 端到端验证 —— 起一个真实预览**

在一个真实的 Vite 项目里：

```bash
npm run build && npm run preview     # 记下端口，通常 4173
mp start --port 4173
```

Expected: 输出 `preview: https://xxx.trycloudflare.com/?t=<43字符>` 与 `expires in 30 min`

- [ ] **Step 4: 用工具的一半验证另一半**

```bash
mp capture
```

Expected: 输出一行 `![shot-1](https://.../_a/.../shot-1.png)` 与 `Page loaded clean: ...`

- [ ] **Step 5: 人工验证四项**

1. 把图片行贴进对话 —— 用户手机应能看到截图（若 Task 3 结论为不可见，则跳过此项）
2. 用户点开 `?t=` 链接 —— 应能在手机上交互该应用
3. 手机上把 `?t=` 去掉再访问 —— **应得到 404**（Cookie 已种，故此项验证的是新会话；用无痕窗口测）
4. 访问 `https://xxx.trycloudflare.com/.env` —— **应得到 404**

- [ ] **Step 6: 验证清理彻底**

```bash
mp stop
mp status
```

Expected: `stopped (N process tree(s) terminated)`，随后 `no active preview`

```bash
tasklist | findstr cloudflared
```

Expected: 无输出 —— 没有残留的 cloudflared 进程

- [ ] **Step 7: 提交**

```bash
git add skill/SKILL.md README.md
git commit -m "docs: skill wrapper, readme, and end-to-end verification"
```

---

## 自查记录

对照设计文档逐节检查：

| 设计文档章节 | 覆盖任务 |
|---|---|
| 2 探针结果 | Task 3（隧道场景下重新验证） |
| 4 架构 | Task 5、6、8 |
| 4.1 鉴权模型 | Task 4、5 |
| 4.2 路径黑名单与 Host 重写 | Task 4、6 |
| 5 `state.js` | Task 1 |
| 5 `tunnel.js` | Task 2 |
| 5 `proxy.js` | Task 5、6 |
| 5 `capture.js` | Task 7 |
| 5 `cli.js` / `SKILL.md` | Task 9、10 |
| 6 命令面 | Task 9 |
| 7 输出契约 | Task 9 |
| 8 错误处理 | Task 8（隧道失败回收、TTL）、Task 9（端口未监听、重复 start） |
| 9 测试策略 | Task 4、5、6、7、10 |
| 10 国内网络 | Task 2（`--protocol http2`） |
| 11 风险 | Task 3 |

两处计划对设计文档的修正，均已在对应任务中要求同步回写设计文档：

1. Job Object 替换为 TTL 自杀 + 陈旧 pid 清理（见 Global Constraints）
2. state 持有明文 token 而非仅哈希（Task 8 Step 5）
