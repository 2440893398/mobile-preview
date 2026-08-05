# mobile-preview 设计文档

日期：2026-08-05
状态：待评审

## 1. 背景与痛点

用户通过 Happy 在手机上远程操作 Codex / Claude Code。AI 开发完一个应用后，用户无法看到运行效果，因而无法给出有效反馈。

约束条件：

- 用户全程在手机上操作，看不到电脑屏幕
- 用户身处中国大陆，手机侧有代理
- 开发机是 Windows 11
- 出于安全考虑，访问地址必须是临时的

## 2. 探针结果（设计的事实基础）

设计前跑了两组验证，结论直接决定了架构：

| 通道 | 结果 | 影响 |
|---|---|---|
| `Read` 本地 PNG → 工具结果 | **手机端看不到** | 「AI 截图发给你看」这条路不存在 |
| Playwright MCP 内联返回图片 | **手机端看不到** | 同上 |
| 回复正文里的 markdown 远程图片 URL | **手机端可正常渲染** | 图片可内联推进对话，前提是公网可达的 URL |
| Playwright MCP 打开 `file:` 协议 | **被拒绝** | 产物必须经 HTTP 提供，不能直接开本地文件 |

两条推论：

1. 能到达用户眼前的东西只有两种：**回复正文里的远程图片**，和**一个可点击的链接**。
2. Happy 抓取内联图片时**不携带用户浏览器的 Cookie**，因此图片 URL 不能用 Cookie 鉴权，否则渲染出破图。

## 3. 目标与非目标

### 目标

- AI 完成开发后，能把截图**内联推进对话**，用户零操作即可看到
- 用户可点开一个**临时链接**，在手机上真实交互该应用
- 录屏（mp4）可通过同一链接播放
- AI 在把结果交给用户之前，能自己先看一眼截图并读到 console 错误，避免递交白屏页面
- 完整生命周期：`start` / `status` / `stop`，不留残余进程和残余隧道

### 非目标

- **不暴露** Happy、Claude Code、Codex、终端、文件系统、调试端口、数据库。临时地址只用于看应用效果。
- 不做二维码。用户在手机上，看不到电脑屏幕，扫不了码。
- 不支持多用户、不做账号体系。
- 第一版只做 Cloudflare Quick Tunnel。frp / Tailscale / cpolar 等国内穿透方案留待后续，届时只需替换 `tunnel.js`。

## 4. 架构

```
手机(挂代理) ──https──> *.trycloudflare.com
                              │
                    cloudflared --protocol http2
                              │
                   ┌──────────▼──────────┐
                   │   mp 鉴权反代 :随机  │
                   └────┬───────────┬────┘
                        │           │
                 /  ────┘           └────  /_a/<random>/
          vite preview / next start        gallery 静态目录
              （默认，非 dev server）       截图 · 录屏 mp4
```

一个隧道承载两类内容，共用一个 cloudflared 进程和一个反代进程。

### 4.1 鉴权模型

| 路径 | 内容 | 鉴权 | 理由 |
|---|---|---|---|
| `/_a/<token>/<文件名>` | 截图、录屏 | **capability URL**：32 字节随机（base64url，43 字符）路径段本身即凭证，不种 Cookie、不重定向 | 只有无 Cookie 依赖，Happy 才能内联渲染 |
| `/` 及其余 | 目标应用 | `?t=<32字节随机>` → 校验后种 HttpOnly Cookie → 302 到 `/`，token 立即作废 | 活服务需要跨请求会话连续性 |

Cookie 属性：`HttpOnly; Secure; SameSite=Lax; Max-Age=<剩余存活秒数>`。

两类凭证都随隧道消亡而失效。默认存活 30 分钟（`--ttl` 可调）；`mp stop` 立即作废。

安全细则：

- 一切鉴权失败返回 **404**，不返回 403 —— 不泄漏路径是否存在
- 全站响应头 `X-Robots-Tag: noindex, nofollow`
- 会话鉴权失败按来源 IP 限流
- token 只出现在 CLI 标准输出，**不写日志、不写 state 文件明文**（state 里只存哈希）
- 反代监听随机高位端口，只绑 `127.0.0.1`

### 4.2 默认暴露构建产物，而非 dev server

`mp start` 默认假定目标是 `vite preview` / `next start` 这类构建产物服务：没有 `/@fs/` 任意文件读取面、没有 sourcemap、没有 HMR 握手。攻击面比 dev server 小一个数量级。

反代无法探测端口背后究竟是什么，因此两种模式的差别落在**路径黑名单**上，这是可实现、可测试的：

| 路径模式 | 默认模式 | `--dev` 模式 |
|---|---|---|
| `/@fs/`、`/.env`、`/.git/` | 404 | **仍然 404** |
| `/@id/`、`/@vite/`、`/node_modules/` | 404 | 放行 |
| `*.map` | 404 | 放行 |

`/@fs/` 与 `.env` 在任何模式下都不放行 —— 它们是 2025 年一系列 Vite 任意文件读取 CVE 的入口，没有任何预览场景需要它们。

`mp start --dev` 另外**重写发往目标的 `Host` 头**为 `localhost:<目标端口>`，从而绕过 Vite 的 `server.allowedHosts` 和 Next.js 的 `allowedDevOrigins` 校验 —— 不需要修改用户的配置文件。

**已知限制（第一版明确不解决）**：`--dev` 模式下 HMR 不保证工作。Vite 客户端会依据页面 host 推断 WebSocket 地址，隧道场景下需要 `server.hmr.clientPort=443` + `protocol=wss`，而这只能由用户配置提供，反代无法在不改写注入脚本的前提下修复。且 Quick Tunnel 对长连接本就不稳。用户主场景是「看效果」而非「边改边热更」，故不为此增加复杂度。`--dev` 启动时打印该限制。

## 5. 模块划分

边界按「能否独立测试」切分。

### `state.js` — 运行态

- 接口：`read()` / `write(patch)` / `clear()`
- 存储：`%LOCALAPPDATA%\mobile-preview\state.json`
- 字段：隧道 URL、反代端口、目标端口、会话 token 哈希、gallery 产物清单、cloudflared pid、proxy pid、过期时间戳
- 依赖：仅 `node:fs`。**不依赖任何其他模块** —— 隧道进程全崩后 `mp status` 仍能报告脏状态并提供清理

### `tunnel.js` — cloudflared 生命周期

- 接口：`start(localPort) → {url}` / `stop()`
- 职责：定位 cloudflared（PATH → winget → 自动下载）；拉起进程并强制 `--protocol http2`；从 stderr 解析 `https://*.trycloudflare.com`；用 **Windows Job Object** 绑定子进程防孤儿；解析超时则报错并回收进程
- 依赖：`node:child_process`、`state.js`

### `proxy.js` — 鉴权 + 反代

- 接口：`listen({targetPort, galleryDir}) → {port, mintToken(), mintArtifactPath(file)}`
- 实现：裸 `node:http`，不引入 Web 框架。该模块必须 fail-closed，依赖越少越易审查
- 职责：两套鉴权、Host 头重写、限流、安全响应头、静态产物服务
- **不感知 cloudflared 的存在**，因此鉴权逻辑可脱离网络单测

### `capture.js` — Playwright 产物生成

- 接口：`capture({url, steps, viewport}) → {shots, video, consoleErrors, failedRequests}`
- 默认手机视口
- `consoleErrors` 与 `failedRequests` 供 AI 自检使用，不面向用户
- **不感知隧道与鉴权**，只针对一个 URL 工作，可对 localhost 独立测试

### `cli.js` / `skill/SKILL.md`

CLI 负责命令分发与输出格式化。SKILL.md 保持精简，只说明何时调用哪条命令、如何将结果贴回对话。Claude Code 与 Codex 各自一份薄包装，共用同一个 CLI。

## 6. 命令面

| 命令 | 作用 |
|---|---|
| `mp start [--port N] [--dev] [--ttl 30]` | 起反代与隧道，输出带 token 的临时链接与过期时间 |
| `mp capture <url> [--steps 文件] [--video]` | 对该 URL 跑 Playwright，截图（及可选录屏）落入 gallery，输出可粘贴的 markdown 图片行。`--steps` 指向一个描述交互步骤的 JS 文件，缺省则只加载首屏 |
| `mp status` | 报告隧道 URL、剩余存活时间、gallery 条目；发现脏状态时提示清理 |
| `mp stop` | 停隧道、停反代、作废凭证、清理 state |

## 7. 输出契约

`mp capture` 结束后输出可原样粘贴的 markdown：

```
![shot-1](https://xxx.trycloudflare.com/_a/9f3c…/shot-1.png)
```

AI 只需复制粘贴，不自行拼接 URL。让 AI 承担的工作越机械，出错概率越低。

`mp start` 输出链接、过期时刻、以及一行给 AI 看的提示（例如 console 错误数量非零时的警告）。

## 8. 错误处理

- 目标端口无监听 → 拒绝 `start`，不建立指向空服务的隧道
- 隧道 URL 解析失败 → 报错并回收已拉起的进程，不留残余
- 重复 `start` → 返回现有隧道，不建立第二条
- 到期 → 反代自行退出、隧道自行退出、state 清理
- `stop` 时进程已不存在 → 视为成功，清理 state

## 9. 测试策略

- **鉴权单测（不碰网络）**：无 token → 404；错 token → 404；正确 token → 种 Cookie 并 302；Cookie 过期 → 404；capability 路径命中与未命中；限流触发
- **路径黑名单单测**：`/@fs/`、`/.env`、`/.git/` 在两种模式下均 404；`/@vite/` 仅在 `--dev` 放行
- **`capture` 单测**：对 localhost 静态页跑一轮，断言产出截图、录屏与 console 采集
- **`tunnel` 冒烟测试**：真实拉起 cloudflared，断言能解析出 URL，断言 `stop` 后进程消失
- **端到端**：隧道建立后用 `capture` 访问该公网 URL —— 用工具的一半验证另一半

## 10. 中国大陆网络注意事项

- cloudflared 默认走 QUIC/UDP 7844，国内干扰明显，故**强制 `--protocol http2`** 走 TCP
- Quick Tunnel **不支持 SSE**（事件堆积至连接关闭才一次性下发），且**并发在途请求上限 200**，超出返回 429。目标应用若依赖 SSE，预览会表现异常，需在文档中提示
- 用户手机侧有代理，`*.trycloudflare.com` 可达

## 11. 风险与待验证

| 风险 | 处置 |
|---|---|
| Happy 抓取内联图片的来源未知（手机客户端直连 or Happy 服务端代理）。若为客户端直连且不走代理，`trycloudflare` 可能不通 | 第一条隧道建立后立即验证：发一张挂在隧道上的图，确认手机可见。此验证前置于其余实现 |
| Quick Tunnel 稳定性无 SLA | `mp status` 暴露隧道健康状态；后续可替换 `tunnel.js` 为 frp/国内方案 |
| 录屏经代理观看带宽受限 | 录屏默认压到手机视口尺寸、限制时长 |

## 12. 后续（不在第一版）

- `tunnel.js` 增加 frp / cpolar 后端，供无代理场景使用
- `--dev` 模式下的 HMR 支持
- 多产物 gallery 索引页
