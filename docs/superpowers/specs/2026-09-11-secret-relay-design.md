# mobile-preview 密钥中继设计（调研稿）

日期：2026-09-11
状态：第一版已实现（0.4.0）；§5.4 的 render、§11 的后续项未做
前置：`2026-08-05-mobile-preview-design.md`、`2026-08-06-mobile-preview-hardening-design.md`

## 1. 背景与痛点

用户通过 Happy 在手机上远程驱动 Claude Code / Codex。AI 在配置对象存储、数据库、
第三方服务时需要 AccessKey、密码一类的凭证。现状只有两条路，都不能接受：

- **贴进聊天**：值进入对话记录、模型上下文、Happy 服务端的加密记录、以及此后每一轮的
  上下文重放。AI 之后完全可以在回复里复述它。
- **回到电脑操作**：用户在手机上，做不到。

要的是：用户在手机上**另开一个页面**把值填进来，AI 之后**能用、不能看、不能输出**，
并且**用途受限**。

## 2. 事实基础

设计前核实了四组事实。它们直接决定了架构里哪些路不能走。

### 2.1 Claude Code 侧

| 事实 | 出处 | 影响 |
|---|---|---|
| `PreToolUse` hook 在**每一种**权限模式下都先于权限检查运行；返回 `deny` 时即使 `bypassPermissions` / `--dangerously-skip-permissions` 也拦截 | code.claude.com/docs/en/hooks-guide §hooks-and-permission-modes | hook 的 deny 是唯一在本用户常用的 bypass 模式下仍生效的强制手段 |
| `settings.json` 的 `permissions.deny` 规则在 bypass 模式下**不生效** | 同上 | 不能靠 `Read(./.env)` 这类规则 |
| hook 返回 `ask` 在 `-p` / `--permission-prompt-tool` 下没有可靠的提示通道，文档建议改用 hook 自动决策 | hooks-guide §limitations | Happy 恰好用 `--permission-prompt-tool`，所以「每次使用前让 Claude Code 弹窗确认」不可靠 |
| `PostToolUse` 只能观察工具输出，**不能改写**它 | code.claude.com/docs/en/hooks §PostToolUse | 输出脱敏必须在 `mp` 自己的进程里做，不能靠 hook 事后擦 |
| 没有任何原生的「密文输入」功能；`AskUserQuestion` 的答案照样进上下文 | 文档无此功能 | 收集环节必须自建 |
| 工具结果一律进入模型上下文，没有「只给用户看」的返回通道 | 工具模型本身 | CLI 的每一行输出都要按「模型会读到」设计 |

### 2.2 Happy 侧

| 事实 | 出处 | 影响 |
|---|---|---|
| 没有任何密文/隐藏输入功能，README、源码目录、issue 里都没有 | github.com/slopus/happy | 不能指望宿主提供通道 |
| 权限确认通过注入的 stdio MCP 工具转发到手机；`AskUserQuestion` 在手机上只显示原始 JSON 和 Approve/Deny | slopus/happy issue #635 | 手机端交互只有「链接」和「文本按钮」两种可用形态 |
| 回复正文里的 `<options>` XML 会被渲染成可点按钮 | 同上 | 链接送达之外的确认可以用它 |
| `happy notify` 可以从命令行向手机推一条通知，能否带可点链接未证实 | slopus/happy issue #1383 | 后续可作为「链接送达」的第二通道 |

### 2.3 MCP 侧

MCP 规范 2025-11-25 新增的 **URL 模式 elicitation** 就是为这件事定义的：服务端要求
密码、API Key 一类敏感信息时**必须**用 URL 模式，客户端把 URL 交给用户在浏览器里
完成，"sensitive credentials never pass through the LLM context, MCP client or any
intermediate MCP servers"。（modelcontextprotocol.io/specification/2025-11-25/client/elicitation）

但 Claude Code 只能确认支持表单模式 elicitation，是否支持 URL 模式**未证实**；Happy
作为远端客户端会不会把这个 URL 显示出来**未证实**。而且即便都支持，链接指向的页面仍然
得让手机能打开，也就是仍然需要隧道。结论：**规范方向正确，当前不能依赖**；本设计的
链接送达沿用 `mp start` 已经验证过的方式——CLI 裸行输出，AI 转贴。日后若宿主支持，
只需把「打印链接」换成「发起 URL elicitation」，其余不变。

### 2.4 业界先例

| 工具 | 做法 | 输出脱敏 |
|---|---|---|
| 1Password `op run` | 把密钥解析成子进程环境变量，仅在进程存活期间存在 | **有**，默认遮蔽 stdout/stderr 里出现的值 |
| GitHub Actions secrets | 注入 + 日志遮蔽（`::add-mask::`） | **有**，但对变形（base64 等）后的值无效 |
| Doppler `doppler run` | 注入环境变量 | 无 |
| Infisical Agent Vault | HTTP 代理，agent 只持有占位符，代理在转发时替换成真值 | 不适用——agent 从未持有真值 |
| IETF draft CB4A | agent 永远不持有长期凭证，只拿短期、窄权限、可审计的代理凭证 | — |

共同点：**没有一家声称能挡住故意作恶的执行者**。它们防的是「不小心打出来」，靠的是
注入而非交付、输出遮蔽、审计，以及把凭证本身做短做窄。本设计采用同一立场，见 §7。

## 3. 目标与非目标

### 目标

- 用户在手机浏览器里填值，值**不经过**对话、模型上下文、Happy 记录
- 值在传输途中对 Cloudflare 边缘也不可见（端到端加密，见 §4.3）
- AI 只能通过 `mp` 提供的几个操作**使用**值，任何操作都不会把值返回给 AI
- 每一次使用都要落在用户在手机上**事先批准的用途清单**内
- 任何使用的输出都经过脱敏，值及其常见变形不会出现在工具结果里
- 值默认只存在于一个有 TTL 的进程内存里，到期即消失；每次使用有审计记录
- 三条命令走完：`ask` → `wait` → `run`，与 `start` / `capture` / `stop` 同样的心智模型

### 非目标

- 不做密码管理器：不做长期保存、不做跨项目共享、不做同步
- 不对抗**故意**作恶的 AI。值一旦进入 AI 能控制的子进程，就不存在技术手段阻止它外泄
  （§7 讲清楚边界和兜底）
- 不做「AI 代填浏览器登录」（1Password Agentic Autofill 那类），场景不同
- 第一版不做把真值写进文件的 `render`，理由见 §5.4

## 4. 架构

```
手机浏览器 ──https──> *.trycloudflare.com ──> cloudflared ──> mp 密钥表单 :随机  ┐
   │ WebCrypto 加密每个字段                                                          │ 同一个 daemon
   └──────────────────────── 密文 ────────────────────────────────────────────────> │ 内存里持有明文
                                                                                    │
  AI 的 shell ── mp secret run ──命名管道/unix socket──> { 校验用途 → 派生子进程 → 脱敏回传 } ┘
```

一个 `ask` 对应一个 **密钥 daemon**。它和预览 daemon 同一套骨架（detached、`stdio: ignore`、
TTL 自杀、按槽写 state），但职责相反：预览 daemon 把东西放出去，密钥 daemon 把东西
关起来。

### 4.1 生命周期

| 阶段 | daemon 在做什么 | 隧道 |
|---|---|---|
| `ask` | 起表单服务，建隧道，写 state（`stage: collecting`） | 开 |
| 用户提交 | 解密、存入内存、写 state（`stage: filled`，只写字段名与指纹） | **立即关**——表单只需要用一次，隧道多活一秒就是多一秒暴露面 |
| `run` 期间 | 监听本地 IPC，执行受限操作 | 关 |
| TTL 到 / `forget` | 清内存、清 state、退出 | — |

隧道存活时间 = 用户打开并填完表单的时间，通常几分钟；密钥存活时间 = `--ttl`，默认 120
分钟，上限 1440。两者分开设置。

### 4.2 表单服务

- 裸 `node:http`，只绑 `127.0.0.1`，和 `proxy.js` 一样 fail-closed
- 鉴权沿用 `auth.js`：`?__mp_token=` 兑换 cookie、宽限窗口、失败 404、按 IP 限流。
  链接预取会烧掉第一次兑换，这个教训已经付过学费，不再重犯
- 页面是一份**内联** HTML，无外部资源。国内实测 50 KB/s，页面必须一次请求到齐
- 页面内容：AI 声明的 `--purpose`、每个字段（密码类字段用 `type=password`）、以及 AI
  声明的**用途清单**做成复选框（默认勾选）。用户能看到 AI 打算拿这些值干什么，不同意
  的取消勾选
- 提交后返回「已收到，可以关闭此页」，daemon 随即杀掉 cloudflared
- 请求体上限 64 KB；只接受一次成功提交，之后所有请求 404

### 4.3 端到端加密

Quick Tunnel 的 TLS 在 Cloudflare 边缘终止，边缘到 cloudflared 是 Cloudflare 自己的
通道。也就是说**Cloudflare 看得到经过隧道的明文**。预览场景无所谓，密钥场景不行。

处置：daemon 每次 `ask` 生成一对 ECDH P-256 密钥（选 P-256 而非 X25519，手机 Safari
的 WebCrypto 对前者支持稳定），公钥内联进页面；页面用 WebCrypto 做 ECDH + HKDF +
AES-GCM，逐字段加密后再 POST；daemon 用私钥在内存里解开。边缘只见密文。

边界：这防的是被动记录。一个主动篡改页面里公钥的中间人仍然能拿到值——这与任何不
带证书固定的 web 方案相同，本设计不宣称能防。

### 4.4 存储：只在内存

| 方案 | 对 AI 的防护 | 对磁盘/其他用户的防护 | 取舍 |
|---|---|---|---|
| daemon 内存 | AI 拿不到句柄；要偷得 dump 进程 | 进程退出即消失 | **默认** |
| DPAPI（CurrentUser）加密文件 | **无**——AI 以同一用户身份运行，`ProtectedData.Unprotect` 一行即可解 | 有 | 只作为 `--persist` 的后续选项，不进第一版 |
| Windows 凭据管理器 | 同上，`cmdkey` 即可读 | 有 | 同上 |

已在本机验证 DPAPI 从 PowerShell 可用（`ProtectedData` 往返正常，Node 22）。但它解决
的不是这个设计要解决的问题，所以先不做。

state 文件（`%LOCALAPPDATA%\mobile-preview\secrets\<id>.json`）里**永远没有值**，只有：
id、purpose、字段名、每个字段的长度和 SHA-256 前 8 位（供用户核对是否填错）、批准的
用途、daemon pid、过期时间、阶段、使用计数。审计日志在 `secrets\<id>.log`。

### 4.5 IPC：只有「做」，没有「取」

`mp secret run` 这个 CLI 进程和 daemon 之间的通道是 Windows 命名管道
（`\\.\pipe\mp-secret-<id>`）/ POSIX unix socket。这一层的关键不在鉴权，在**协议里根本
没有返回值的操作**：

| 操作 | daemon 做什么 | 回给 CLI 的是什么 |
|---|---|---|
| `run {argv, cwd, envNames}` | 校验用途 → `spawn(argv[0], argv.slice(1), {shell:false, env: 注入})` → 逐块脱敏 | 脱敏后的 stdout/stderr、退出码 |
| `status` | 读自己的元数据 | 字段名、指纹、用途、剩余 TTL |
| `forget` | 清内存并退出 | ok |

AI 就算绕过 CLI 直接连管道，能发的也只是这三种请求。**值不跨进程边界**，这是整个设计
里唯一一条靠构造而不是靠策略成立的保证。

## 5. 命令面

全部挂在 `mp secret <子命令>` 下，`--json` 语义与现有命令一致（stdout 只给机器，散文去
stderr）。

### 5.1 `mp secret ask`

```
mp secret ask --purpose "配置 OSS 上传" \
  --field OSS_ACCESS_KEY_ID --field OSS_ACCESS_KEY_SECRET:secret --field OSS_BUCKET:text \
  --use "npm run deploy" --use "node scripts/check-oss.js" \
  [--ttl 120] [--form-ttl 30] [--json]
```

| 参数 | 含义 |
|---|---|
| `--purpose` | 一句话，显示在表单顶部。用户据此判断这个链接是不是自己那个 AI 发的 |
| `--field NAME[:secret\|text]` | 字段。默认 `secret`（密码框、不回显）；`text` 用于 bucket 名、endpoint 这类不敏感但顺手一起填的值 |
| `--use "<argv>"` | 声明打算用这些值运行的命令，可多条。用户在表单上逐条勾选 |
| `--ttl` | 值在内存里的存活分钟数（默认 120，1–1440） |
| `--form-ttl` | 表单链接存活分钟数（默认 30，见 §12） |

输出：一个裸行链接，加一个 `id`。命令**不等待**用户填写——和 `mp start` 一样，起 daemon、
拿到隧道链接就返回，等待交给 `wait`。

### 5.2 `mp secret wait --id <id> [--timeout 540]`

阻塞到 `stage` 变成 `filled`、或表单过期、或超时。成功时输出：

```json
{ "status": "filled", "id": "s-7f3a",
  "fields": [{ "name": "OSS_ACCESS_KEY_ID", "length": 24, "sha256_8": "9c1e0b2a" }, …],
  "uses": ["npm run deploy", "node scripts/check-oss.js"],
  "expiresAt": 1757580000000 }
```

`uses` 是用户**实际勾选**的清单，可能比声明的少。默认 540 秒，留在 Bash 工具 10 分钟
上限之内。

### 5.3 `mp secret run --id <id> [--cwd <dir>] -- <argv…>`

- `argv` 必须与批准的用途之一**逐项相等**（不是前缀、不是子串）。不匹配则拒绝，并提示
  用 `mp secret ask --id <id> --use "<新命令>"` 追加用途——这会再发一个只含「批准新用途」
  的链接，值不用重填
- `shell: false`。用户批准的是一个 argv，不是一段能被 `&&` 拼接的 shell 字符串
- 环境变量注入所有字段。像 `dotenv` 这类库默认**不覆盖**已存在的环境变量，所以项目里
  `.env` 写 `OSS_ACCESS_KEY_SECRET=` 留空即可，真值由注入提供，磁盘上永远没有它
- stdout/stderr 经脱敏后原样回传，退出码透传

脱敏规则：对每个 `secret` 字段的值，替换其本体、base64、base64url、URL 编码、JSON 转义
四种形态为 `[REDACTED:NAME]`；长度小于 8 的值不做变形匹配（误伤太多），只匹配本体。
和 GitHub Actions 一样，这挡不住 AI 有意变形后再打印，这不是它的目标。

### 5.4 为什么第一版没有 `render`（把真值写进文件）

一旦真值落盘，就要靠 hook 挡住 `Read`、`cat`、`Get-Content`、`type`、`Grep`、`Glob`
等所有读路径，而对 `Bash` 命令字符串做路径匹配只能是启发式的。与其上一层漏的网，
不如让磁盘上根本没有值：

- 绝大多数工具支持从环境变量取凭证（ossutil、aws、psql、Prisma、dotenv 系）
- 只认配置文件的工具（`~/.ossutilconfig` 之类）可以通过 `mp secret run -- <该工具> config …`
  让它自己写——写出来的文件仍然在磁盘上，但那是工具自己的行为，用户批准的正是这一条

确实需要 `render` 的场景留到 1.1 版：写文件 + 在 state 里记 `renderedFiles` + hook 对这些
路径 deny + `mp secret peek <file>` 提供打码视图。

### 5.5 `mp secret status` / `mp secret forget [--id <id> | --all]`

与 `mp status` / `mp stop` 同构。`status` 列出每个槽的 id、purpose、字段名与指纹、批准的
用途、剩余 TTL、使用次数；`forget` 让 daemon 清内存退出，并沿用现有的孤儿清扫。

## 6. 插件侧

### 6.1 hooks

| 事件 | 匹配 | 决策 | 目的 |
|---|---|---|---|
| `PreToolUse` | `Bash\|PowerShell` | 命令含 `mp secret run` 且 argv 里出现 `set`、`env`、`printenv`、`Get-ChildItem env:`、`$env:` 等环境导出形态 → `deny` | 拦最粗的一类「借批准的命令把环境打出来」 |
| `PreToolUse` | `Bash\|PowerShell` | 命令把 `mp secret run` 的输出再管道给 `base64`、`certutil -encode`、`xxd`、`od` → `deny` | 拦对脱敏的最直接绕过 |
| `PreToolUse` | `Bash\|PowerShell\|Read\|Grep` | 路径命中 `secrets\*.json` 所记的 `renderedFiles`（1.1 版） → `deny` | 落盘真值的读保护 |

只用 `deny`，不用 `ask`：§2.1 已确认 `ask` 在 Happy 的驱动方式下没有可靠通道，而
`deny` 在包括 bypass 在内的所有模式都生效。启发式规则一定有漏，它们是第三道防线，
不是第一道。

### 6.2 SessionStart 上下文与 SKILL.md

现有的远程会话提示追加一条：在这种会话里，凡是要用户提供密码、AccessKey、Token 一类
的值，**不要**让用户贴到聊天里，改为 `mp secret ask` → 裸行链接 → `mp secret wait` →
`mp secret run`。SKILL.md 增加同样的工作流，并写明：CLI 的输出里永远不会有值，不要
去找；核对用户是否填错用 `sha256_8` 和长度，或直接跑一条批准过的检查命令看退出码。

## 7. 威胁模型：能保证什么、不能保证什么

| 威胁 | 处置 | 依据 |
|---|---|---|
| 值进入对话记录 / 模型上下文 | 从不经过对话；CLI 输出无值 | 构造 |
| AI 无意中把值打印出来 | 子进程输出脱敏 | 构造（在 daemon 内做，不依赖 hook） |
| AI 用值做未经同意的事 | 用途逐项相等匹配，用户在手机上勾选 | 构造 |
| AI 读到落盘的值 | 第一版不落盘 | 构造 |
| 值在 Cloudflare 边缘被记录 | 页面内 ECDH + AES-GCM | 构造 |
| 链接泄漏后被兑换 | token + 宽限窗口 + 表单 TTL + 一次提交后 404 | 构造 |
| AI 绕过 CLI 直连 IPC | 协议里没有取值操作 | 构造 |
| AI 借批准的命令把环境导出（`cmd /c set`） | 用途匹配挡住未批准的 argv；hook 挡住最粗的形态 | 策略 |
| AI 改 `package.json` 的 `deploy` 脚本让它把 `$OSS_SECRET` 写到文件 | **挡不住** | — |
| AI 对脱敏做变形绕过（先 rot13 再打印） | **挡不住** | — |
| AI dump daemon 进程内存 | **挡不住**（同一用户身份） | — |

最后三行是所有本地方案的共同边界，`op run`、GitHub Actions 也一样。兜底不在工具里，
在凭证本身：

- **给 AI 的凭证做成子账号 / 临时凭证**：OSS 用 RAM 子账号只授一个 bucket 的写权限，
  或直接用 STS 临时 token；数据库开一个只有目标库权限的账号。这样即便泄漏，损失也是有
  边界、可撤销的
- **TTL 短**：默认 2 小时，任务完成就 `forget`
- **审计**：`secrets\<id>.log` 记每次 `run` 的 argv、时刻、退出码，事后看得见 AI 用它干了什么

真正把「AI 拿不到值」变成技术保证，只有两条路：daemon 跑在**另一个 Windows 用户**下
（值和 IPC 都跨账号，AI 无法 dump），或把用途做成 daemon **内建操作**（如「检查这组
OSS 凭证是否有效」「上传这个目录」，Infisical Agent Vault 的思路），值根本不进 AI 能
控制的进程。两者都超出第一版，列入 §11。

## 8. 模块划分

| 模块 | 职责 | 复用 |
|---|---|---|
| `secret-form.js` | 表单页 HTML、字段解密、一次提交、用途勾选结果 | `auth.js` 全部（token、cookie、宽限、限流、404） |
| `secret-daemon.js` | 生命周期、内存持值、IPC 服务、用途校验、`spawn` 与脱敏 | `daemon.js` 的 detached / TTL / state 写法；`tunnel.js` 的 `startTunnel` 原样 |
| `scrub.js` | 值及四种变形的流式替换 | 纯函数，单测 |
| `secret-state.js` 或 `state.js` 扩展 | `secrets\<id>.json` 读写、锁、列表 | `state.js` 的原子写与锁直接搬 |
| `cli.js` | `secret` 子命令分发；`COMMANDS` 表要支持一层子命令 | `parseArgs`、`settleStart` 的轮询骨架 |
| `plugins/mobile-preview/hooks/pre-tool-use.mjs` | §6.1 的三条 deny | 与 `session-start.mjs` 同构 |

`secret-form.js` 与 `scrub.js` 不感知隧道与进程，可离线单测；`secret-daemon.js` 保留
`startTunnelFn` 桩，和 `runDaemon` 一样能在测试进程内跑完。

## 9. 国内网络的连带影响

- 每次 `ask` 要**新建一条隧道**（不复用预览隧道：那会让表单和被预览的应用同源，预览
  的是 dev server 时尤其不可接受）。实测 `api.trycloudflare.com` 三次成一次，所以一次
  `ask` 把所有字段和用途一并收齐，不要一个值一条链接
- 表单页面自包含，一次往返到齐
- `wait` 的默认超时按人填一张表的时间给，不按网络给

## 10. 测试策略

沿用 `node --test`。

- **`auth.js` 复用部分**：已有测试覆盖，不重写
- **`secret-form.js`**：无 token 404；正确 token 兑换 cookie；提交前需 cookie；提交体超
  限拒绝；第二次提交 404；勾选结果正确落入 state；解密失败拒绝且不写任何值
- **`scrub.js`**：本体、base64、base64url、URL 编码、JSON 转义各一例；跨 chunk 边界
  的值也被替换；短值只匹配本体
- **`secret-daemon.js`（进程内）**：`run` 用途不匹配拒绝；匹配则子进程拿到环境变量而
  CLI 拿不到；提交后隧道进程被杀；TTL 到期内存清空、state 清除；IPC 上不存在取值操作
  （发一个伪造的 `get` 请求，断言协议错误）
- **hooks**：三条 deny 各一正一反
- **`cli.js`**：`ask` 打印裸行链接与 id；`wait` 在 filled / 过期 / 超时三种结束各一例；
  `run` 缺 `--` 报错；`status` / `forget` 与现有命令的端口消解规则同构
- **端到端**：真隧道 + Playwright 在手机视口打开表单、填写、提交，断言 `wait` 返回、
  值不在任何输出与文件里出现——用工具的一半验证另一半，和预览一样

## 11. 后续（不在第一版）

- `render` + 落盘读保护 + `peek`（§5.4）
- `--persist`：DPAPI / Keychain 加密落盘，只解决「daemon 重启后不用重填」，不改变对 AI
  的防护边界，文档里要写清楚
- 内建用途：`check-oss`、`check-db`、`put-object` 这类值不进 AI 子进程的操作
- 跨账号 daemon：以另一个 Windows 用户运行，值与 IPC 都跨账号
- 链接送达的第二通道：`happy notify` 推送；宿主支持后换成 MCP URL 模式 elicitation
- 预览与密钥共用一个 cloudflared（省一次建隧道），前提是解决同源问题，例如用两个
  hostname——Quick Tunnel 做不到，得等换穿透后端

## 12. 真机实测记录（2026-09-11）

第一版实现完成后，在真实隧道上跑了一轮手机端全流程：`ask` 发链接 → 手机填表 →
`wait` → `run`。**流程整体打通**：页面在 iPhone 视口下正常渲染，浏览器侧的 ECDH +
AES-GCM 加密真实生效（密文中不含明文），提交后隧道按设计立即关闭，`run` 成功把值注入
子进程并透传退出码。同时暴露三个问题，均已修复。

### 12.1 短值的编码形态没有被遮蔽（安全缺陷）

用户填的测试值是 4 个字符。`run` 的输出是：

```
TEST_SECRET length=4 value=[REDACTED:TEST_SECRET]
base64=Y2VzdA==
```

本体遮蔽住了，紧挨着的 base64 原样打了出来——**值当场可还原**。

成因：`scrub.js` 的 `MIN_VARIANT_LEN = 8` 按**输入**长度决定要不要生成变形模式。这个
门槛设在了错误的一侧：它想防的是「模式太短导致误伤」，而一个 4 字符值的 base64 是
8 个字符的独特串，误伤概率极低；真正会误伤的是短**输入**的本体，而本体本来就无条件
匹配。

处置：门槛改为判断**编码后**的长度（≥4），且编码与原值相同时不重复登记（纯字母数字的
URL 编码与 JSON 转义就是它自己）。多行值按行拆分的那条规则保留 8 字符门槛——它防的是
另一回事：值里若有一行是 `x`，输出里每个 x 都会被抹掉。

这条缺陷靠单元测试发现不了，因为原测试恰好把错误行为写成了断言（「短值只匹配本体」）。
只有真人填了一个短值才暴露。

### 12.2 表单窗口默认 10 分钟太短（可用性）

第一次试跑的链接在 15 分钟窗口内无人提交，自动过期；用户点开时得到的是设计要求的
无差别 404，看起来就是「链接打不开」，无从判断发生了什么。

真实节奏是「AI 发链接 → 用户看到通知 → 拿起手机 → 翻出密钥 → 输入」，10 分钟不够。
默认改为 30 分钟，上限仍为 60。这不削弱安全性：窗口内链接是 bearer 凭证这一点没变，
而值的存活时间由独立的 `--ttl` 控制。

### 12.3 hook 把 `--` 之后的后续语句当成 argv（误报），且漏了 §6.1 第二条

实测时 `mp secret run --id X -- node check.mjs; "exit: $LASTEXITCODE"` 被 hook 拒绝：
`argvAfterSeparator` 把 `--` 之后的**整个字符串**当作 argv，于是 PowerShell 的后续语句
连同 `$LASTEXITCODE` 一起被判定为环境导出。

argv 到第一个未被引号包住的 shell 操作符就结束了——shell 自己也是这么断的。拒绝正确的
命令不是「保守」，它会把模型训练成绕开这个 hook，比放行更糟。

处置：新增 `splitPipeline`，按未加引号的 `|` `;` `&` `&&` `||` 切段，argv 只取
`mp secret run` 所在那一段。顺带补上 §6.1 原本就要求、第一版却漏实现的第二条规则：
`mp secret run` 的输出被管道给 `base64` / `certutil` / `xxd` / `Format-Hex` /
`[Convert]::ToBase64String` 这类编码器时拒绝——脱敏发生在 daemon 输出的那一刻，
再编码一次就得到了 daemon 没见过的形态。只是 `Select-String` 这类筛选则放行。

### 12.4 连带修掉的 Windows 问题

`spawnArgv` 解析 `npm` 时选中了 `C:\Program Files\nodejs\npm`——Node 安装包放在
`npm.cmd` 旁边的那个无扩展名 shell 脚本。它是文件、在 PATH 上，而 Windows 无法执行它，
于是任何 `mp secret run -- npm …` 都以 ENOENT 失败。候选名单改为只接受带 PATHEXT
扩展名的路径，不再接受裸名。
