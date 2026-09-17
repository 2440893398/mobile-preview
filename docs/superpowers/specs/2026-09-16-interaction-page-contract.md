# 交互页面回传约定

日期：2026-09-16。状态：草案，已在临时目录跑通一条完整链路（见末尾）。取代 [P0 方案](../plans/2026-09-16-p0-validation-plan.md) §1 的 json-render 路线。

## 0. 分工

- **页面由 baoyu-design 出，解释按 eli5 写。** 视觉、排版、文案密度、CJK 字体栈、44px 触控目标，全部按 baoyu-design 的 `system-prompt.md` 里「How to do design work」「Content Guidelines」「Output creation guidelines」三节执行；"为什么需要你"和术语解释按 eli5 的一句话原则：面向零基础读者，多图少字。本项目不维护组件库。
- **本项目只定三件事**：页面必须满足的硬约束、答案怎么从页面回到 CLI、CLI 怎么把页面挂起来。这就是本文。
- **对 baoyu-design 流程的覆盖**（写进本项目 skill，优先级高于它的默认流程）：
  - 不问澄清问题。介入请求本身就是设计简报，问题已经由 Agent 整理好。
  - 不建 `designs/` 项目目录，不跑 `record-asset.mjs`，不导入设计系统。
  - 不用 React + Babel，不用任何 CDN。单个自包含 HTML，原生 HTML/CSS/JS。它自己也允许「单屏移动端 mock 从一开始就一个文件」。
  - 预览与截图走 `mp`，不走它文档里的 localhost 方案。

## 1. 页面硬约束（CLI 端 check 强制）

| 规则 | 原因 |
|---|---|
| 单文件，≤ 300 KB | 内联进认证代理页，隧道下手机可接受 |
| `<!doctype html>`、`<html lang>`、viewport meta | 手机渲染与 CJK 断行 |
| 不允许任何 `http(s)://` 外部资源：script、link、img、font、CSS `url()`、`@import` | CSP `default-src 'none'`，且离线/弱网下页面不能残缺 |
| 不允许 `<script type="module">` | 单文件内联，CSP 只放行 `'unsafe-inline'` |
| 不允许 `<form action>` | CSP `form-action 'none'`；提交只走桥接脚本 |
| 不允许 React/Babel 运行时痕迹 | 无 CDN 即无法加载 |
| 至少一个 `[data-mp-submit]` | 没有提交入口的页面没有意义 |
| 至少一个答案载体：`name=` 表单控件、`[data-mp-value]` 或 `MP.set(` | 否则 answers 为空 |
| 不得自带或覆盖 `window.MP` | 桥接脚本由 CLI 注入 |
| 建议有 `[data-mp-receipt]` | 没有时桥接脚本追加固定底栏 |
| 上百词正文却什么都没画（无 `<svg>`／`<figure>`）只警告不拦 | 那是加了边距的聊天消息，页面白开了；但有些问题确实只能用文字问，所以不是硬失败 |

检查失败时页面不上线，CLI 把 problems 原样返回给 Agent 重写。

## 2. 答案载体

页面作者只需做到以下任意一种，桥接脚本负责收集：

1. **原生表单控件带 `name`**。text/date/number/textarea 取值；number 转数字，空为 null。单个 checkbox 为布尔，同名多个 checkbox 为选中值数组；radio 为选中值；`<select multiple>` 为数组。
2. **自定义控件**：元素带 `name` 和 `data-mp-value`（JSON 字符串），或在脚本里调用 `MP.set(name, value)`。排序、对照批注这类结构化答案用这条。
3. 收集范围是 `[data-mp-form]` 元素内部；没有则整个 body。

`required` 属性有效：disposition 为 answered 时，未填的 required 控件会阻止提交并聚焦。

## 3. 提交入口

任何元素加 `data-mp-submit` 即为提交按钮。可选属性：

- `data-mp-disposition`：`answered`（默认）、`needs_clarification`、`declined`、`deferred`
- `data-mp-reason`：附带原因字符串，原样进入响应

脚本里也可 `MP.submit(disposition, extra)`。

## 4. 桥接脚本提供的 API

由 CLI 在 `</body>` 前注入，页面不引用。

| 调用 | 作用 |
|---|---|
| `MP.set(name, value)` | 写入结构化答案，并触发草稿保存 |
| `MP.get(name)` | 读当前值 |
| `MP.draft(name)` | 读上次草稿里的值，用于自定义控件恢复 |
| `MP.answers()` | 当前完整 answers |
| `MP.submit(disposition, extra)` | 程序化提交 |
| 事件 `mp:ready` | 桥接就绪、草稿已恢复到原生控件后触发；自定义控件在此事件里调 `MP.draft` |

草稿：任何 input/change 或 `MP.set` 后写 localStorage（键 `mp:draft:<requestId>:<contentDigest>`，按页面而不是按 revision，链接过期后原页重发能接上），并 800 ms 防抖 POST `/draft` 到 CLI。

恢复顺序：先读 localStorage；没有就 `GET /state` 要本机那份（换浏览器打开的人只有这一条路）。从服务端恢复时，页面上没有同名控件的键会被放回 `store`，否则排序这类值只会显示在屏幕上、不会回到 answers 里。两条路都走完才触发 `mp:ready`。提交成功后清除。

## 5. 传输

- 注入的 `window.MP_REQUEST = { requestId, revision, contentDigest }`。
- `GET /state`：`{ status, requestId, revision, draft }`，作答后 404。
- `POST /draft`：`{ requestId, revision, answers }`，仅 waiting 状态接受，204。
- `POST /submit`：`{ requestId, revision, contentDigest, responseId, disposition, answers, reason? }`。
  - `contentDigest` 不符 → 409 `stale`，页面提示重新打开。
  - 同一 `responseId` 重复 → 返回同一 receiptId，`duplicate: true`；前一份还在处理中 → 409 `busy`，页面按「稍等」处理而不是「失败」。
  - 成功 → `{ receiptId, status: "submitted" }`。
- CSP：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'`。

`mp interaction wait` 的输出把 `/state` 的内容按 [P0 §2.2](../plans/2026-09-16-p0-validation-plan.md) 整理：waiting 时带 draft，submitted 时带完整响应。

## 6. skill 正文草案（本项目的技能，两宿主共用）

```
当需要用户做判断且满足触发条件（见 SessionStart 注入规则）：
1. 整理 InteractionRequest：为什么需要人、要操作什么、选择改变什么、各项的稳定 ID。
2. 解释部分按 eli5 的原则写：
   Explain like I'm someone who knows nothing about this topic, using a HTML
   artifact with big pictures and few words.
   面向对这个领域一无所知的人；能画就不写，字越少越好；术语出现一次就用一句人话
   解释。"图"指用 HTML/CSS 或内联 SVG 画的关系图、时间线、前后对照，不是外链图片，
   也不是装饰插画。这条覆盖 baoyu-design 里"避免用 SVG 画图"的规则，仅限解释性图解。
3. 读取 baoyu-design 的 system-prompt.md 中「How to do design work」「Content Guidelines」
   「Output creation guidelines」三节，按其标准写一个单文件 HTML，遵守本约定第 1 到 3 节。
   不问澄清问题，不建 designs/ 目录，不用 React/Babel/CDN。
4. mp interaction ask --html <file>  → 检查通过则打印链接；失败则按 problems 重写。
5. 把链接作为裸行交给用户。
6. mp interaction wait --id <id>；status 为 waiting 就再等，按 resumePolicy 停止。
7. 用返回的 answers 继续任务；needs_clarification 时先回应 reason 再重开页面（revision+1）。
```

eli5 原文来自本机 `~/.claude/skills/eli5/SKILL.md`（Claude Code 官方文档的示例技能，10 行，无许可证文件）。只取那一句核心指令，不依赖该技能是否安装。

## 7. 已验证

临时目录 `C:\Users\24408\tmp\interaction-p0`（bridge.js、check.mjs、serve.mjs、prioritize.html）。桌面 Chromium 390×844：

- 页面 8.6 KB，check 通过，严格 CSP 下零控制台错误。
- 上移两次、排除一件后 `MP.answers()` 为 `{"order":["onboard","invoice","blog","backup"],"excluded":["blog"]}`；localStorage 与服务端 `/state.draft` 同步一致。
- 刷新后顺序、排除状态、底部摘要全部恢复。
- 提交返回 receiptId，两个提交按钮禁用，回执文案显示在 `[data-mp-receipt]`，本地草稿清除，服务端 status 变为 submitted。

未验证：真机首屏、断网提交的提示、`needs_clarification` 分支（按钮已在页面上，未点）。
