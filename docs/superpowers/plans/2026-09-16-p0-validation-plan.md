# P0 验证方案：json-render 试验、wait 循环与触发机制

日期：2026-09-16。状态：验证方案，未实施。上游文档：[通用人工介入交互层 v2](2026-09-16-human-interaction-layer-v2.md) §10 P0。

P0 只回答三个问题，其余全部推后：

1. json-render 能否作为组件组合层塞进现有的认证单页架构，并把结构化答案原样送回。
2. 在当前宿主（Claude Code + Happy）里，「页面提交 → 原 Agent 在同一任务里继续」这条链路怎样才算可靠。
3. Agent 能否在需要人判断的那一刻自己开页面，而不是等用户手动要求（§6）。

## 0. 本轮已核实的事实

以下均来自当前仓库源码或官方页面，是设计的硬约束。

| 事实 | 出处 | 对 P0 的影响 |
|---|---|---|
| `mp secret wait` 默认 540s 超时，最大 3600s；超时后以失败退出并提示重跑 | `src/secret-cli.js` wait() | Bash 工具单次上限 600s，540s 是为它留的余量。interaction wait 沿用同一数值和「重跑即续等」的语义 |
| wait 通过轮询本地状态文件（500ms）判断 stage，不依赖长连接 | 同上 | 手机断网、隧道抖动不影响 Agent 侧等待；不需要 WebSocket |
| 表单页 CSP：`default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'` | `src/secret-form.js` | 页面所有 JS 必须内联为单个 `<script>`；不能从 CDN 加载 json-render，也不能用 ES module import |
| 表单页借用预览代理的认证：token 交换、宽限期、失败一律 404、按 IP 限流 | `src/secret-form.js` 头注释 | interaction 页面复用这一层，不新做认证 |
| 预览代理不转发 WebSocket | README | 与 Superpowers helper.js 的 WebSocket 传输不兼容，坚持 HTTP POST |
| daemon 记录 `expiresAt`/`ttlMinutes`（默认 120 分钟），到期自杀 | `src/secret-daemon.js` | interaction 请求的生命周期可沿用 daemon 模式，但 TTL 要独立可配 |
| PreToolUse hook 在 bypassPermissions 下仍能 deny | `plugins/mobile-preview/hooks/pre-tool-use.mjs` | interaction 不涉及密钥，不需要这条防线；但说明插件已有 hook 分发机制可复用 |
| json-render 由 Vercel Labs 发布，Apache-2.0，`@json-render/core` + 多种渲染器（React、Vue、Svelte、Solid、RN、Ink 等） | json-render.dev、GitHub | 许可证无障碍。没有「零框架」渲染器，任一渲染器都要带一个 UI 运行时 |
| json-render catalog 用 Zod 定义组件与 action；状态用 `$state`/`$bindState` 绑定；组件通过 `emit` 触发 action | 同上 | 答案回传路径清楚：state 树 + emit 的 action 就是 InteractionResponse 的原料 |
| 插件 SessionStart hook 在 Claude Code 与 Codex 读同一份 hooks.json，返回同一格式的 additionalContext；只在 startup/resume/clear/compact 触发，本地会话不输出 | `hooks/hooks.json`、`hooks/session-start.mjs` | 触发提示词的注入点已经存在，每会话只付一次 token |
| Claude Code：Stop hook 收到 `last_assistant_message`，退出码 2 或 `decision: block` 可让 Agent 带 reason 继续；PreToolUse matcher 可指定 `AskUserQuestion` 并 deny | Claude Code hooks 文档 | 第 6 节的第二、三层触发在 Claude Code 上有文档依据 |
| Codex：支持 SessionStart、UserPromptSubmit、PreToolUse、Stop 等 12 个事件；Stop 输入含 `last_assistant_message`，返回 `decision: block` 会用 reason 生成续接提示；插件可带 hooks.json | Codex hooks 文档 | Stop 兜底两侧都能做 |
| Codex 提问工具名为 `request_user_input`，属于「local function tools」，PreToolUse 可按名 deny；但默认模式系统提示要求必答问题用纯文本问、不用该工具，且 `default_mode_request_user_input` 特性未开 | Codex 0.154.0 二进制、`codex features list`、[核实记录](../research/2026-09-16-codex-question-tool-hooks.md) | Codex 侧第二层可做但命中率低，Stop 兜底升为 Codex 主保障 |

## 1. json-render 试验

> 2026-09-16 已在桌面 Chromium 完成，结果见[试验记录](../research/2026-09-16-json-render-p0.md)。A：可内联，gzip 139 KB，zod 占三分之二。B：成立。C：json-render 自带校验漏掉缺 prop 和成环，自写 40 行预检补齐。
>
> **同日用户决定放弃 json-render 路线**：手写组件的页面观感不达标，改由 baoyu-design 按其设计标准直接生成单文件 HTML，本项目只定义[回传约定](../specs/2026-09-16-interaction-page-contract.md)。约定已在临时目录跑通一条完整链路（草稿、恢复、提交、回执）。本节其余内容保留为记录。

### 1.1 要证伪的假设

假设 A：`@json-render/core` + 一个渲染器 + UI 运行时，可以用 esbuild 打成单个 IIFE 内联进表单页，体积在手机 4G 下可接受。

假设 B：自定义 catalog 里新增的四个语义组件（ExplainPanel、Comparison、RankedList、DiffReview）的状态能通过 `$bindState` 完整落到 state 树，POST 时不需要组件私有序列化逻辑。

假设 C：AI 生成的 JSON 不合法时，渲染器能在提交前拦住，并且把已填的部分保留下来，而不是白屏。

任一假设被证伪，就退到自写小解释器，只覆盖 v2 §4 的七类介入。

### 1.2 步骤

在仓库外的临时目录做，不进入 `src/`。

1. 装包并记录：`@json-render/core` 与候选渲染器的精确版本、依赖树深度、许可证清单。
2. 选渲染器。先比三者，按「运行时体积 + 是否能整包内联」排序：
   - Svelte 渲染器：编译期运行时最小，优先试。
   - Solid 渲染器：次选。
   - React 渲染器：官方主线，功能最全，体积最大，作为对照。
3. 用 esbuild 打包成单个 IIFE，`--minify`，记录原始与 gzip 体积。门槛：gzip 后 ≤ 150 KB 继续，150–300 KB 记录后由用户定，>300 KB 视为 A 证伪。
4. 把打包产物粘进一个复制自 `secret-form.js` 的静态页面，保持原 CSP 不变，确认在 iOS Safari、Android Chrome 各打开一次，记录首屏时间。
5. 写一个最小 catalog：Text、Field、Select、Checkbox 来自现成组件；新增 ExplainPanel（折叠解释）、Comparison（同维度表）、RankedList（拖拽排序）、DiffReview（原文/改稿对照 + 逐段评论）。四个新组件只做 UI，不做业务。
6. 用三份 fixture 各渲染一次（见 §3），把 state 树 `JSON.stringify` 后与预期 InteractionResponse.answers 逐字段比对。
7. 故意喂三种坏 JSON：未知组件、缺必填 prop、循环引用的 `$state`。记录渲染器行为，以及已填字段是否保留。
8. 断网测试：填一半关掉 Wi-Fi 再提交，看页面提示与本地草稿是否在恢复网络后可续。

### 1.3 记录格式

产出一份 `docs/superpowers/research/json-render-p0.md`，字段固定：

- 版本、许可证、依赖数
- 各渲染器 gzip 体积与首屏时间（两台手机）
- 假设 A/B/C 各自的结论与证据
- 决定：采用 / 自写 / 需再试

## 2. wait 循环设计

### 2.1 当前宿主的恢复方式

Claude Code 里 Agent 唯一可靠的「等人」方式，是让一个 Bash 命令阻塞。secret relay 已用这个方式跑通真机。interaction 不发明新机制，直接复用：

```
mp interaction ask --request <file.json>     → 打印链接（裸行，给手机）
mp interaction wait --id <id> [--timeout 540] → 阻塞到提交或超时
```

与 secret 的关键差异只有一条：**wait 在 stdout 直接输出 InteractionResponse JSON**。secret 刻意不打印任何值，interaction 正相反，整个价值就是把结构化答案交给 Agent。两条命令共享 daemon 骨架、认证和隧道，但结果输出路径分开实现，不做条件分支复用。

### 2.2 超时与续等

人的思考时间常超过 10 分钟，所以 wait 必然多次超时。设计：

- 默认 `--timeout 540`，与 secret 一致，留给 Bash 600s 上限一分钟余量。
- 超时不是错误。退出码 0，stdout 输出 `{"status":"waiting","id":...,"revision":N,"formExpiresAt":...,"draft":{...}}`。secret 的超时用非零退出并提示重跑，interaction 改为零退出，因为 skill 要把它当正常分支处理，非零退出会让部分宿主把回合标记为失败。
- `draft` 字段返回页面已自动保存的部分答案（只有 status 为 waiting 时出现）。Agent 可以据此在聊天里说「你已经填了 3 项，还差排序」，减少用户切回页面的次数。
- Skill 里写死循环规则：收到 waiting 就再执行一次 wait，最多 N 轮（默认 8 轮 ≈ 72 分钟），超过后把链接再发一次并停止等待，让用户主动唤醒。N 由请求的 `resumePolicy` 覆盖。
- 页面链接到期（`formExpiresAt`）与 daemon TTL 分离：链接到期只是不能再打开，daemon 仍保留草稿和已提交答案到 TTL；wait 在两者之间返回 `status: "expired_link"` 并附带 draft。

### 2.3 提交后的三态

沿用 v2 §8 的状态，但 P0 只实现前三个，且在 wait 输出里体现：

| status | 含义 | wait 行为 |
|---|---|---|
| waiting | 未提交 | 超时返回，带 draft |
| submitted | 已持久化，用户看到回执 | 立即返回完整 InteractionResponse |
| delivered | wait 已把它交给 Agent | wait 返回后 daemon 自动标记，页面显示「已送达任务」 |

applied 不在 P0：那需要 Agent 回写，等 P3。

### 2.4 幂等与错投

- 每次 ask 生成独立 id 与 daemon；wait 只按 id 读，跨会话不可能串。
- 提交带 `responseId`（页面生成 UUID）；同一 responseId 重复 POST 返回同一回执。
- wait 返回过 submitted 后再次执行，仍返回同一响应（不是错误），便于 Agent 上下文被压缩后重取。
- 提交时校验 `contentDigest` 与请求一致；不一致返回 409，页面提示重新加载。

### 2.5 需要实测的宿主行为

以下不能推断，P0 要逐条真机记录：

1. Bash 阻塞 540s 期间 Happy 客户端是否保持会话，手机锁屏后回来 Agent 是否仍在。
2. wait 超时返回 waiting 后，Agent 是否会按 skill 自动再等，还是转去问用户。这是 skill 措辞问题，要用真实回合验证。
3. Claude Code 上下文压缩后，Agent 是否还记得 id。对策：wait 输出里始终带 `next: mp interaction wait --id X`，并在 `mp interaction status` 里列出所有未完成请求。
4. 用户在页面提交的同时又在聊天里回答了，两个答案冲突时 Agent 的行为。P0 只记录，不解决。
5. Happy 是否支持 MCP Apps 或 elicitation。按 v2 的要求，只按实测记，不按产品名推。P0 预期答案是「不支持」，浏览器入口为唯一入口。

## 3. 三个 fixture

与 v2 §10 P0 一致，跨领域，不含任何数据库或 gantt 词汇：

| fixture | 介入类型 | 页面组件 | 预期 answers |
|---|---|---|---|
| 补充活动日期与地点 | clarify + configure | ExplainPanel + Field×3 + Select | `{date, city, audienceSize, unknown:[...]}` |
| 排序四件本周工作 | prioritize | ExplainPanel + RankedList + 分组勾选 | `{orderedIds:[...], excluded:[...]}` |
| 审阅一段 300 字文稿 | review | DiffReview + 逐段评论 + 「前提不对」按钮 | `{contentEdits:[{anchor,text}], annotations:[...], disposition}` |

每个 fixture 各跑一次完整链路：ask → 手机打开 → 填写 → wait 返回 → 用返回的 JSON 手工核对是否足以让 Agent 继续。第三个 fixture 额外测「前提不对」分支，看 disposition 是否为 needs_clarification 且 draft 保留。

## 4. 验收

P0 完成的标志，全部要有真机记录：

- json-render 三个假设各有明确结论，形成采用或自写的决定。
- 三个 fixture 各一条成功回传记录，含 wait 的原始 stdout。
- 至少一次跨 540s 超时后续等成功的记录。
- 至少一次链接到期后 draft 仍可取回的记录。
- §2.5 五条宿主行为各有一句实测结论。
- §6 的三层触发各有一次真机记录：至少一次 Agent 未经用户要求自行开页面，且是在长文输出之前。

未达成前不进入 P1，不写协议 schema。

## 5. 明确不做

- 不改 `src/` 任何文件；试验代码在仓库外。
- 不接 MCP Apps、A2UI、AG-UI、LangGraph。
- 不做沙箱自由 HTML。
- 不做 applied 状态与 Agent 回写。
- 不做多用户身份。

## 6. 触发机制验证

> 2026-09-17 三层已实现，测试 32 条全过（`tests/triggers.test.js`），并用真实 hook 进程逐条烟雾验证。实现与本节草案的三处偏差记在 6.6。

要解决的问题：Agent 应在需要人判断的那一刻自己开页面，而不是先输出长文，再等用户说「用插件处理一下」。后者多花一轮 token，页面也来得慢。

三层触发按成本递增，第一层是主力，后两层分别负责精准时机和兜底。P0 只验证它们在真机上是否按预期动作，不追求阈值调优。

### 6.1 第一层：SessionStart 注入判断规则

在现有 mobile-preview 提示之后追加一段，两宿主共用。草案：

```
- When you are about to ask the user to compare three or more options,
  set two or more parameters, put items in order, or review content
  longer than a screen, do not write it out in the chat. Run
  `mp interaction ask` with the request, hand over the printed link as
  a bare line, then `mp interaction wait --id <id>` and act on the JSON
  it prints. A single yes/no or one-field question stays in the chat.
- If `wait` prints status "waiting", run it again; stop after the
  request's resume policy says so, and hand the link over once more.
```

约束：

- 总长控制在 120 个英文词以内。现有提示约 200 词，两段合计不超过 350 词，压缩后重注入的成本可接受。
- 只写判断条件和命令，不写解释原则；解释原则放在 skill 正文，Agent 决定开页面后再读。
- 本地会话不注入，与现有逻辑一致。本地用户同样需要交互页面，但入口是桌面浏览器，措辞不同；P0 不做本地分支。

验证：三个 fixture 各自用一段自然的用户请求触发，看 Agent 是否在第一回合就执行 ask，而不是先铺方案。记录三次的实际首句。

### 6.2 第二层：PreToolUse 拦截提问工具

Agent 调用宿主提问工具时，已经判断「需要人来定」，这是最精准的时机。hook 读取工具入参，满足任一条件就 deny 并附 reason：

- 选项数 ≥ 3 且任一选项说明超过 40 字，或
- 问题数 ≥ 2 且彼此有依赖，或
- 问题正文超过 400 字。

reason 固定一句：「This question is large enough for a page. Run `mp interaction ask` instead; see the mobile-preview skill.」不在 reason 里重复规则，Agent 已经有第一层的上下文。

不拦的情况：单题、选项 ≤ 2、只在本地会话。误拦的代价是 Agent 多一次工具调用，可接受；漏拦交给第三层。

宿主差异：

- Claude Code：matcher 写 `AskUserQuestion`，与现有 `Bash|PowerShell` 的 PreToolUse 并列。
- Codex：工具名 `request_user_input`，matcher 直接写它，deny 形式与 Claude Code 相同。但默认模式下模型被要求把必答问题写成纯文本、不调用该工具，所以这一层在 Codex 上只能拦到「可选问题」。Codex 的主保障是第三层。用户若在 config.toml 开 `tools.experimental_request_user_input.enabled = true`，命中率会提高；这是用户配置，插件不改写。详见[核实记录](../research/2026-09-16-codex-question-tool-hooks.md)。

验证：构造一个 5 选项的问题，让 Agent 在 Happy 会话里提问，记录 hook 是否 deny、Agent 收到 reason 后是否改走 ask。同一问题在本地会话重复一次，确认不拦。

### 6.3 第三层：Stop 兜底

回合结束时检查 `last_assistant_message`（两宿主都提供此字段，Codex 侧可能为 null，为 null 时放行）。条件：

- 长度超过 1500 字，且
- 最后 300 字里含有问句或列出了编号/项目符号的选项，且
- 本回合没有执行过 `mp interaction ask`。

满足则 block，reason：「The message above asks the user to decide; turn it into an interaction page with `mp interaction ask` and hand over the link.」

防护：

- 检查 `stop_hook_active`，为 true 时直接放行，避免和自身循环。
- 同一会话最多 block 两次，超过则放行并在 stderr 记一行，防止 Agent 在某种输出格式上反复被拦。
- 本地会话不启用。

此层的 token 已经花掉，它存在只为省掉用户手动催促那一轮。Claude Code 上若第一层在三个 fixture 全部命中，第三层可延后到 P4；Codex 上不能延后，因为它的默认提示把必答问题推向纯文本，第二层拦不到。

### 6.4 不做的事

- 不用 UserPromptSubmit 每回合注入规则。
- 不在 hook 里判断任务内容是否「重要」，只看结构（选项数、长度、依赖）。
- 不在 P0 调阈值；三个数字先取上面的初值，等 P5 的对比数据再动。

### 6.5 记录

在 `docs/superpowers/research/trigger-p0.md` 记：每层在两宿主上的可用性、三个 fixture 的首回合行为、误拦与漏拦各几次。

### 6.6 实现与草案的偏差（2026-09-17）

实现见 `plugins/mobile-preview/hooks/` 下的 `session-start.mjs`（第一层）、`ask-question.mjs`（第二层）、`stop.mjs`（第三层），加两个共用件 `session-mark.mjs`、`hook-io.mjs`。三处和上面的草案不一样，都是写的时候发现的：

**一、会话是不是手机会话，只判断一次。** 草案里三层各自判断。实测这件事不便宜：Codex 那边环境变量答不了，要走进程树，Windows 上约一秒。第三层每个回合都跑，付不起。改成 SessionStart 判完写进 `<state>/sessions/<sessionId>.json`，后两层只读。读不到就当本地、一声不吭——认不出来时不多事，是这三个 hook 唯一允许的失败方式。

**二、阈值按阅读时间算，不按字符数。** 草案写的是「选项说明超过 40 字」「正文超过 400 字」。同一句话中文 26 个字符、英文 123 个，按字符数一刀切，中文会话里这个功能等于没装。改成把 CJK 字符按 3 计权（阅读时间的比值，不是字符数的比值），阈值随之变成：任一问题的选项总量 > 150 且选项数 ≥ 3；问题数 ≥ 2 且总量 > 250;总量 > 400。`tests/triggers.test.js` 里有一条专门守这个比例。

「问题数 ≥ 2 且彼此有依赖」里的依赖判断不到，用「问题数 ≥ 2 且分量够」代替。这是有意的近似，不是漏掉。

**三、第三层多一道闸：页面已经开着就不拦。** 草案用「本回合没执行过 ask」。实现改成查 `<state>/interactions/` 下有没有活着的记录——「模型写了长文代替页面」和「模型开了页面正在介绍它」在消息文本里长得几乎一样，是一对反义词，按状态分辨比按文本分辨可靠。

另外 SessionStart 现在要读 stdin 才拿得到 session_id，而它原来不读。宿主若给的是不会关闭的 stdin，hook 会一直挂到 hooks.json 的 timeout，整段注入静默失效。`hook-io.mjs` 给读取加了上限，超时按「没有负载」处理。

注入文字现在 385 词（原来约 300）。草案定的预算是 350，超了 35 词，测试里的红线设在 400。再加东西之前得先往 skill 里挪。

### 6.7 仍然只能真机验证的

- Codex 侧：`plugin_hooks` 特性显示 removed 时，插件目录里的 hooks.json 到底还加不加载。
- Codex 侧：deny 掉 `request_user_input` 之后，模型是改走 `mp interaction ask`，还是退回纯文本提问。
- 两侧：第一层能不能在长文输出**之前**就命中——这是整件事的主要指标，第二三层都只是补救。
