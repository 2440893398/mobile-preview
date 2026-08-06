# mobile-preview 加固设计

日期：2026-08-06
状态：待评审
前置：`2026-08-05-mobile-preview-design.md`（本文修订其 §4.1）

## 1. 背景

2026-08-06 做了第一次真实手机端试跑：本地起一个静态页（含 ffmpeg 生成的 mp4）跑在 4321 端口，`mp start` 建隧道，用户在手机上打开。**最终打通了**——页面、交互、视频播放全部正常。但过程中暴露了五个问题，本文逐条处置。

试跑实测数据，作为后续决策的事实基础：

| 观测项 | 实测 |
|---|---|
| `api.trycloudflare.com` 可达性 | 直连 3 次成 1 次；走本地代理 3 次成 1 次 |
| 隧道建立成功率 | 一次 1 次成功，另一次连试 8 次才成 |
| 隧道数据面 | 527KB 图片下到 128KB 中断，其后连续 530 |
| 带宽 | 约 50KB/s |
| 端到端 | HTML 200 / 6047B / 2.6s；mp4 200 / 143KB / 5.0s |

## 2. 变更总览

| # | 问题 | 处置 | 触及模块 |
|---|---|---|---|
| 1 | 一次性令牌被链接预取烧掉 | 改为宽限窗口 | `proxy.js` |
| 2 | 长令牌 URL 在手机客户端传不出去 | SKILL.md 增加输出规则 | `skill/SKILL.md` |
| 3 | `startTunnel` 无重试，网络抖动即失败 | 内置重试 | `tunnel.js` |
| 4 | 全局单槽 `state.json`，会话间互踩 | 改为按端口多槽 | `state.js` `daemon.js` `cli.js` |
| 5 | 国内网络实况无文档 | README 增加实测章节 | `README.md` |

## 3. 状态存储：一文件一预览

### 3.1 目录布局

```
%LOCALAPPDATA%\mobile-preview\
  previews\4321.json                ← 每条预览一个状态文件
  previews\4321.cloudflared.log     ← 每条预览一份隧道日志
  gallery\4321\shot-1.png           ← 每条预览一个产物目录
```

### 3.2 为什么不是单文件存 map

单文件存 `{"4321": {...}, "3000": {...}}` 需要读-改-写。多个 daemon 并发写会丢条目，而**并存正是这次改动的目的**，用一个自带竞争的存储去实现并存是自相矛盾的。

一文件一预览下，每个 daemon 只写自己那份，无竞争；清理一条预览就是删一个文件；`mp status` 遍历目录即可。

### 3.3 接口

```js
previewsDir()            → %LOCALAPPDATA%\mobile-preview\previews
statePath(port)          → previews\<port>.json
tunnelLogPath(port)      → previews\<port>.cloudflared.log
galleryDir(port)         → %LOCALAPPDATA%\mobile-preview\gallery\<port>
legacyStatePath()        → %LOCALAPPDATA%\mobile-preview\state.json

read(port)               → object | null
write(port, patch)       → object
clear(port)              → void
list()                   → [{ targetPort, ...state }]   按端口升序
```

`list()` 跳过无法解析的 JSON 和文件名非纯数字的条目，不抛异常——状态目录是 `mp status` 最后的求助对象，它必须在任何脏状态下都能给出报告。

`galleryDir` 从 `cli.js` 移入 `state.js`：它是路径职责，和 `statePath` 同类。`cli.js` 不再自行拼接。

### 3.4 gallery 必须分目录

这是多槽的连带后果，不是可选项。现在两条预览共用一个 `gallery/`，`mp capture` 都写 `shot-1.png`，后一条直接覆盖前一条的产物；而两条预览的 gallery token 不同，却指向同一批文件，capability URL 的隔离形同虚设。

## 4. 命令面

| 命令 | 行为 |
|---|---|
| `mp start --port N [--dev] [--ttl 30] [--grace 10]` | N 已有活预览则返回它；否则新建。端口即键，不再存在「拿到别的端口的链接」 |
| `mp capture [--port N] [...]` | 见下方端口消解规则 |
| `mp status` | 列出全部活预览：端口、URL、剩余分钟、产物数。无活预览时输出 `no active preview` |
| `mp stop [--port N] [--all]` | 见下方端口消解规则；`--all` 停全部并清扫遗留 |

### 4.1 端口消解规则

`capture` 与 `stop` 未显式给出 `--port` 时：

| 活预览数 | `capture` | `stop` |
|---|---|---|
| 0 | 报错退出：`no active preview. Run \`mp start\` first.` | 视为成功，输出 `stopped (0)`，顺带清扫脏状态 |
| 1 | 用它 | 用它 |
| ≥2 | **报错退出**，列出候选端口 | **报错退出**，列出候选端口 |

多条时不猜。用户在手机上看不到全局状态，停错服务、截错应用的代价远高于多打一个 `--port`。

0 条时两者分歧是刻意的：`capture` 没有对象就无事可做，是错误；而 `stop` 的语义是「确保没有预览在跑」，本来就没有即已达成，报错只会让清理脚本无谓失败。

### 4.2 修掉的 bug

原 `cli.js` 的 `cmdStart` 只判断「现有预览是否健康」，未比对端口：

```js
const existing = state.read()
if (previewHealth(existing).active) { console.log(formatStart(...)); return }
```

于是 B 会话执行 `mp start --port 3000` 时，若 A 会话的 4321 预览还活着，B 会拿到 A 的链接，指向完全不相干的应用。改为按端口读取后，此 bug 自然消失。

## 5. 令牌宽限窗口

### 5.1 对 §4.1 的修订

前一版设计写的是「校验后种 Cookie → 302，token 立即作废」。该决定买到的是：URL 日后从聊天记录、终端回滚或日志中泄漏时，已经是废的。

试跑证明它的代价过高：**链接预取先于人点击**，用户拿到的必然是 404；换设备打不开；且失败静默——404 是设计要求（不泄漏路径存在性），用户完全无从判断发生了什么。

### 5.2 语义

`proxy.js` 中的布尔量 `sessionTokenExchanged` 换成时间戳 `graceUntil`：

| 情形 | 行为 |
|---|---|
| 令牌不匹配 | 404，计入 IP 限流 |
| 令牌匹配，`graceUntil` 未设置（首次兑换） | `graceUntil = now + grace`，种 cookie，302 |
| 令牌匹配，`now < graceUntil` | 种 cookie，302（预取烧掉的就是这一次） |
| 令牌匹配，`now >= graceUntil` | 404，计入 IP 限流 |

窗口**从首次兑换开始计时**，而非从签发开始。若二十分钟内无人兑换，用户此时点击才是首次兑换，窗口这时才打开——比从签发计时更宽容，且不削弱防泄漏：泄漏重放总是发生在正常使用之后。

窗口外的正确令牌计入限流，因为那正是泄漏重放的形状。

### 5.3 参数

`--grace <分钟>`，默认 10。**`--grace 0` 保留一次性语义**：首次兑换后 `graceUntil = now`，窗口为空区间（`now < now` 恒假），其后任何兑换都落在窗口外。安全要求高的场景可退回原行为。

宽限窗口不延长会话生命：`expiresAt` 的检查在所有分支之前，TTL 到期一切归 404。

## 6. 隧道重试

`startTunnel(localPort, { timeoutMs, logPath, bin, spawnFn, tries = 4, retryDelayMs = 2000 })`

单次尝试的失败判定沿用现有两种：握手超时、产出 URL 前进程退出。任一失败则回收进程、等待 `retryDelayMs`、重来，直到成功或耗尽 `tries`。全部失败时抛出的错误须写明尝试次数与最后一次的失败原因，并指向日志文件。

### 6.1 日志截断时机

现在 `createLogSink` 每次 `startTunnel` 调用清空一次。加入重试后必须改为：**整个调用只在第一次尝试前清空，其后追加**。否则前几次失败的现场会被最后一次覆盖——而那正是最该留下的东西。每次尝试前写一行 `--- attempt N/M ---` 分隔。

### 6.2 为什么是 4 次

实测一次 1 次即成，另一次 8 次才成。4 次配 2 秒间隔，最坏约 2 分钟（含每次 30 秒握手超时），仍在人可等待的范围内。次数写成参数，实测若不够可调，不必改代码结构。

重试只覆盖建立阶段。隧道建成后的数据面中断（试跑中出现过）不在本次范围内，见 §9。

## 7. 文档

### 7.1 README

新增「国内网络实况」章节，写入 §1 的实测数字，并说明：

- 为何强制 `--protocol http2`（QUIC/UDP 7844 干扰严重）
- 建立阶段已内置重试，仍全败时的排查路径（先看 `previews\<port>.cloudflared.log`）
- 隧道建成后仍可能中断，表现为 530 或传输截断，重跑 `mp start` 即可
- 带宽量级，据此控制录屏尺寸与时长

### 7.2 skill/SKILL.md

新增输出规则：

> 预览链接必须以裸行形式输出，禁止包在代码块、反引号或任何 markdown 修饰中。多数手机客户端里代码块既不可点击也不可选中复制，链接会无法送达用户。

这是试跑中真实发生过的失败：`mp start` 本身就是裸行输出 `preview: https://...`，是调用方把它塞进了代码块，导致用户拿不到链接。规则写在 SKILL.md 里，因为犯错的是读 SKILL.md 的那一方。

## 8. 迁移与兼容

旧版遗留的根目录 `state.json` 按「陈旧预览」处置：`mp status` 与 `mp stop` 发现它时，杀掉其中记录的 `daemonPid` / `tunnelPid` 再删除文件，并在输出中说明清掉了什么——静默的破坏性动作会让人怀疑工具。不做字段迁移：预览是短命对象，救活一条旧预览没有价值，避免留下孤儿隧道才有。

`mp status` 带清理副作用是沿用现有行为（原 `cmdStatus` 已在发现陈旧状态时调用 `cleanupStale()`），本次不改这个约定。

## 9. 非目标

- **不做数据面重连**。隧道建成后中断（530、传输截断）本次不处理，重跑 `mp start` 即可。真要解决得换穿透方案，属于 `tunnel.js` 后端替换的范围。
- **不做多预览的产物索引页**。`mp status` 报告端口与产物数即可。
- 不改 gallery 的 capability URL 鉴权模型。它在试跑中工作正常，且是 Happy 能内联图片的前提。

## 10. 测试策略

沿用现有 `node --test`，全程 TDD。

**`state.js`**
- 两个端口的写入互不干扰；`clear(4321)` 不影响 3000
- `list()` 返回全部预览、按端口升序
- `list()` 跳过损坏 JSON 与非数字文件名，不抛异常
- 状态目录不存在时 `list()` 返回空数组

**`proxy.js`（宽限窗口）**
- 首次兑换：种 cookie + 302
- 窗口内二次兑换：仍种 cookie + 302
- 窗口外兑换正确令牌：404，且计入限流
- 错误令牌：任何时刻 404 + 计数
- `grace = 0`：第二次兑换即 404（等价原一次性语义）
- TTL 到期优先于宽限窗口：一律 404

**`tunnel.js`（重试）**
- `spawnFn` 桩：前两次失败、第三次成功 → 返回 URL，且 `spawnFn` 被调用 3 次
- 全部失败 → 错误信息含尝试次数与日志路径
- 日志跨尝试**不被截断**，且含各次的分隔标记
- 首次即成功时不产生额外尝试

**`cli.js`（端口消解）**
- 0 条活预览时 `capture` 报错退出；`stop` 成功退出
- 1 条时省略 `--port` 可用
- ≥2 条时 `capture` / `stop` 省略 `--port` 均报错，且错误信息列出候选端口
- `stop --all` 停掉全部
- `start --port N` 在 N 已有活预览时返回该预览；在**别的**端口有活预览时正常新建（回归 §4.2 的 bug）

**`daemon.js`**
- `cleanupStale(port)` 只动该端口
- `cleanupAll()` 清扫全部并处置遗留 `state.json`

## 11. 实施顺序

1. `state.js` 多槽 + 测试（其余模块都依赖它的新接口）
2. `daemon.js` 跟进 `cleanupStale(port)` / `cleanupAll()` + 测试
3. `cli.js` 端口消解与四条命令 + 测试
4. `proxy.js` 宽限窗口 + 测试（与 1–3 无耦合，可并行）
5. `tunnel.js` 重试与日志截断时机 + 测试（同上，可并行）
6. `README.md` 与 `skill/SKILL.md`
7. 真机复验：重跑一次手机端试跑，确认五条都实际生效
