# 需求简报 — mobile-preview 操作手册

> 阶段：P0（需求理解）
> 创建时间：2026-09-20
> 运行模式：generate（全新，`publish/` 与 `work/` 此前均为空）
> 系统画像：不适用（非 Web 项目 — `package.json` 声明 `bin: { mp: ./src/bin.js }`，产物是 CLI）

## 需求来源

| 项 | 内容 | 来源 |
|---|---|---|
| 原始请求 | 写一份这个插件怎么用的操作手册，含使用技巧与使用流程，让小白也能轻松上手；中英双语；在已开源的仓库里补充手册地址 | 用户消息（2026-09-20） |
| 产品仓库 | https://github.com/2440893398/mobile-preview | `plugins/mobile-preview/.claude-plugin/plugin.json:homepage` |
| 当前版本 | 0.5.3 | `package.json:version` |

## 必问清单核对

| 必问项 | 状态 | 内容 / 出处 |
|---|---|---|
| 业务目标与成功标准 | ✅ 用户已答 | 目标：让没接触过本工具的人照着手册就能上手。成功标准：小白能独立完成安装 → 跑通第一次预览。来源：用户消息「让小白也能轻松上手使用」 |
| 目标角色与权限边界 | `[推断]` | 单一角色：在自己电脑上跑前端项目的开发者，对本机有完全权限；无多角色/无服务端权限模型。出处：`src/cli.js`、`src/state.js:6-9`（状态只写本机 `%LOCALAPPDATA%`，无账号体系） |
| 核心流程与关键异常分支 | `[推断]` | 主流程：安装 → `mp doctor` → `mp start` → 手机打开链接 → `mp capture` → `mp stop`。异常分支：cloudflared 缺失、`npm link` 后 shell 看不到 `mp`、PowerShell `mp` 撞 `Move-ItemProperty`、隧道建不起来/建起来后掉线（530）、`--dev` 白屏、截图白屏、`--video` 缺 ffmpeg。出处：`README.md`「Running from mainland China」、`src/doctor.js:55-125`、`src/usage.js` |
| 范围边界 | ⬜ 待确认 | 见「待确认问题」Q2 — 进阶能力（`mp secret` / `mp interaction` / 插件与 hooks 安装）是否纳入 |
| 输出文档类型与受众 | ⚠️ 部分 | 受众已明确（小白）；文档形态与双语组织方式待确认，见 Q1、Q3 |

## 功能地图

| 模块 | 命令 | 作用 | 对小白的必要性 | 出处 |
|---|---|---|---|---|
| 环境自检 | `mp doctor` | 逐项报告缺什么并给出修复命令 | 必备 | `src/doctor.js` |
| 预览 | `mp start` | 把本地端口开成带 token 的临时公网链接 | 必备 | `src/usage.js` COMMANDS.start |
| 查看 | `mp status` | 列出活跃预览、链接、剩余 TTL | 必备 | COMMANDS.status |
| 截图诊断 | `mp capture` | 手机尺寸截图 + 失败请求/控制台报告 | 必备 | COMMANDS.capture、`src/capture.js` |
| 收尾 | `mp stop` | 拆隧道、回收孤儿进程 | 必备 | COMMANDS.stop |
| 密钥中继 | `mp secret ask/wait/run/status/forget` | 手机填凭据，AI 可用不可读 | 进阶（待定） | COMMANDS['secret *']、`docs/superpowers/specs/2026-09-11-secret-relay-design.md` |
| 决策页 | `mp interaction ask/wait/status/close` | 把选择题做成页面，答案回 JSON | 进阶（待定） | COMMANDS['interaction *']、`docs/superpowers/specs/2026-09-16-interaction-page-contract.md` |
| 插件与 hooks | `/plugin marketplace add` 等 | 让 AI 自动想到用这套工具 | 进阶（待定） | `.claude-plugin/marketplace.json`、`plugins/mobile-preview/hooks/` |

模块关系：环境自检是所有模块的前置；预览是截图的前置（`capture` 默认走唯一活跃预览）；
密钥中继与决策页各自独立，不依赖预览。

## 术语表

| 术语 | 别名 / 易混 | 说明 |
|---|---|---|
| 预览（preview） | 隧道、临时链接 | 一个端口对应一个槽位的后台守护进程 + cloudflared 隧道 |
| token | 口令、`__mp_token` | 链接里的 32 字节凭证；缺失一律返回 404。旧式 `?t=` 仍接受但不再签发 |
| TTL | 有效期 | 预览默认 30 分钟；secret 值默认 120 分钟；表单链接默认 30 分钟 |
| grace | 宽限期 | 链接首次使用后仍可换取会话的分钟数，默认等于 TTL，`0` 为一次性 |
| 槽位（slot） | — | 预览按端口、secret/interaction 按随机 id 各占一个槽位 |
| `mp.cmd` | — | Windows PowerShell 中必须使用的写法，`mp` 在那里是 `Move-ItemProperty` 别名 |
| Quick Tunnel | trycloudflare | 本工具使用的免登录 Cloudflare 隧道，公共基础设施 |

## 范围边界

**确定包含**：安装与自检、第一次预览的完整路径、日常四命令节奏、`--dev` 与 SPA 截图技巧、
排错表、国内网络注意事项、安全边界（链接即密码）。

**确定不包含**：源码架构讲解、贡献指南、设计决策推导（这些已在 `README.md` 与
`docs/superpowers/specs/` 中）。

**待定**：`mp secret`、`mp interaction`、插件/hooks 安装三块 — 见 Q2。

## 待确认问题

| 编号 | 问题 | 为何必须由用户决定 |
|---|---|---|
| Q1 | 手册的发布形态与落盘位置 | skill 的标准产物是 `docs/.doc-automation/publish/` 下的多页 Diátaxis 结构；但用户要的是「在开源仓库里能对外给出的一个地址」，两者路径观感差别很大，且决定后续是否拆页 |
| Q2 | 范围是否含三块进阶能力 | 直接决定篇幅与批次数量；「小白手册」可能只要跑通预览，也可能要覆盖插件全部卖点 |
| Q3 | 中英双语的组织方式 | 决定目录结构与后续维护成本（整套镜像 / 仅入口双语 / 同页并列） |

> 三项均为「不同答案导致产出明显不同」的分叉，按 skill P0 规则本轮停下等待答复，
> 未写 `doc-plan.md`，未产出任何 `publish/` 内容。
