# json-render P0 试验记录

日期：2026-09-16。对应 [P0 验证方案](../plans/2026-09-16-p0-validation-plan.md) §1。试验目录 `C:\Users\24408\tmp\json-render-p0`（仓库外，未提交）。桌面 Chromium 390×844 视口实测；真机首屏与断网测试待用户在手机上完成。

## 版本、许可证、依赖

| 包 | 版本 | 许可证 |
|---|---|---|
| @json-render/core | 0.20.0 | Apache-2.0 |
| @json-render/svelte | 0.20.0 | Apache-2.0 |
| zod（core 的 peer） | 4.6.5 | MIT |
| svelte | 5.57.0 | MIT |
| esbuild / esbuild-svelte | 0.28.2 / 最新 | MIT |

装完 node_modules 共 52 个包。官方 npm 源在本机极慢（拉一个 react 清单 215 秒），改 npmmirror 后 12 秒装完。

## 假设 A：能否单文件内联，体积可接受

**结论：能内联，体积卡在门槛边缘；zod 是唯一的大头。**

Svelte 渲染器 + core + 10 个自定义组件，esbuild 打成单个 IIFE，`production` 条件：

| 指标 | 值 |
|---|---|
| minified | 591 KB |
| gzip | 139 KB |
| brotli | 117 KB |
| 打包耗时 | 1.3 s |

minified 归属：

| 包 | KB |
|---|---|
| zod | 443 |
| svelte 运行时 | 67 |
| @json-render/core | 40 |
| @json-render/svelte | 15 |
| 自写组件 + App | 12 |

把 zod 替换成空桩后（仅测体积，不可运行）：minified 138 KB，**gzip 47 KB**。也就是说，zod 一家占了 gzip 的三分之二。

能否换 zod/mini：core 的 dist 里有 13 处链式 `.optional()`，zod/mini 的 schema 实例没有链式方法，直接 alias 会在运行时报错。要瘦身只能等上游改成 mini 写法，或者不在浏览器端跑 zod（见下文假设 C 的启示）。

CSP 验证：页面头部沿用 secret-form 的 `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'`，三个 fixture 均正常渲染，控制台零错误、零警告。

未测：Solid 与 React 渲染器。zod 占比已说明渲染器选型不是体积的决定因素，React 运行时（约 45 KB gzip）只会更差。

## 假设 B：$bindState 能否把答案原样落到 state 树

**结论：成立，三个 fixture 的 state 树就是 InteractionResponse.answers，无需组件私有序列化。**

| fixture | 操作 | 服务端收到的 answers |
|---|---|---|
| 补充活动信息 | 填日期、勾"还没定"、选城市、填人数、提交 | `{"date":"2026-10-18","city":"sz","audienceSize":"80","unknownDate":true}` |
| 排序四件事 | 入职文档上移两次、排除博客、提交 | `{"order":["onboard","invoice","blog","backup"],"excluded":["blog"]}` |
| 审阅文稿 | 改第二段、两段各写意见、点"前提不对" | `{"edits":[{"anchor":"p2","text":"…"}],"comments":[{"anchor":"p2",…},{"anchor":"p3",…}]}` 且 `disposition:"needs_clarification"`, `reason:"should-not-shorten"` |

四个新组件（ExplainPanel、Comparison、RankedList、DiffReview）每个 20 到 40 行 Svelte。绑定方式统一：组件收到 `props`（已解析值）和 `bindings`（prop 名到状态路径），用 `getBoundProp` 读写。RankedList 和 DiffReview 写回的是数组，和标量字段一样直接落到 state。

"前提不对"分支验证：action 的 params 原样透传，已填的草稿一起带回。

桌面 Chromium 的 mount 时间：首个 fixture 368 ms（含脚本首次解析），后续 26 到 82 ms。

## 假设 C：坏 JSON 能否在提交前拦住

**结论：json-render 自带的两层校验不够，但补一个 40 行的预检就够了。**

| 坏样例 | `validateSpec`（结构） | `catalog.validate`（zod） | 渲染器行为 |
|---|---|---|---|
| 未知组件 Slider | 通过 | **拦住**，列出合法类型 | 页面显示校验失败面板 |
| Field 缺必填 label | 通过 | **放行** | 渲染出一个没有标签的输入框 |
| children 纯成环 root→a→root | 通过 | 通过 | 栈溢出，被 json-render 的错误边界接住，页面不挂 |
| 悬空引用 ghost | **拦住** | 通过 | 不渲染 |

缺 prop 放行的原因在 core 源码 `propsOf` 分支：catalog 里组件多于一个时，props 校验退化为 `record<string, unknown>`。这是 0.20.0 的实际行为，不是配置问题。

自写预检（`precheck.mjs`）：逐元素按 catalog 的 zod schema 校验 props，`$` 表达式位置允许缺省，再做一次 children 深度优先找环。三个坏样例全部命中，三个好样例全部通过，每次 0.2 到 1.4 ms。

启示：这个预检可以放在 CLI 端（Node）跑，在页面生成之前就拒绝坏 spec。这样浏览器端的 `catalog.validate` 就不再必要，理论上可以把 zod 移出浏览器包，回到 47 KB。但 `defineCatalog` 本身要求传入 zod schema，浏览器端仍需一份"不带 zod 的 catalog"，这需要改 registry 的构造方式，P0 未验证。

## 决定

> **这条结论已经作废。** 同日的[页面回传约定](../specs/2026-09-16-interaction-page-contract.md)取代了
> json-render 路线：最终实现是"模型写单文件 HTML + CLI 注入桥接"，仓库里没有 json-render 依赖。
> 下面保留原判断，是为了记住它建立在哪些实测数字上——如果以后要回到 schema 渲染，
> 被这些数字否掉的是"json-render + zod + svelte 这套库"，不是 schema 这个想法本身。

**采用 json-render，附三个条件。**

1. 生成后先在 CLI 端跑自写预检（props + 环），再交给页面；不依赖 `catalog.validate`。
2. 首版接受 139 KB gzip；P1 里试验"浏览器端不带 zod 的 catalog"，目标 50 KB 以内。做不到也不阻塞。
3. 渲染器定 Svelte；不再评估 Solid 与 React。

## 待真机

- iOS Safari、Android Chrome 各打开一次三个 fixture，记录首屏时间和排序按钮的触控体验。
- 填一半断网再提交，看错误提示；当前页面没有本地草稿，断网提交会直接失败并显示错误文本，这是 P3 的持久化范围。

## 复现

```
cd C:\Users\24408\tmp\json-render-p0
node build.mjs svelte          # 体积报告
node serve.mjs svelte 4173     # http://127.0.0.1:4173/?fixture=clarify|prioritize|review|bad-unknown|bad-missing|bad-cycle2
node precheck.mjs              # 预检六个样例
```

提交记录在 `submissions/`。截图：`.playwright-mcp/json-render-p0-prioritize-390.png`。
