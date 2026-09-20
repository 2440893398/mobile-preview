# 需求简报 — mobile-preview 操作手册

> 阶段：P0（需求理解）— 第二轮，按新门禁返工
> 创建时间：2026-09-20；返工时间：2026-09-20
> 运行模式：generate（重建）。上一轮的 24 页产物保留为历史，上一版简报见 `context-brief.bak.md`
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
| 范围边界 | ✅ 用户已答 | 全部五组命令都纳入（README 被取代，手册必须写全），但按**最小页数**组织：6 页每语言。插件与 hooks 安装只给入口，细节链回 `plugins/mobile-preview/README.md` |
| 输出文档类型与受众 | ✅ 用户已答 | 操作手册（Diátaxis 多页），受众=第一次用这个工具的开发者；中英各一套，一一对应 |
| 与既有文档的关系 | ✅ 用户已答 | 取代 `README.md` 的使用部分，见「既有文档与去重策略」 |

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

**确定包含**：安装与自检、第一次预览的完整路径、日常预览节奏（`--dev` / 多端口 / TTL / 收尾）、
截图与录像诊断、密钥中继、决策页、全部命令与参数速查、排错、国内网络注意事项、
安全边界（链接即密码）。

**确定不包含**：源码架构讲解、贡献指南、设计决策推导（留在 `docs/superpowers/specs/`）；
hooks 的配置细节（留在 `plugins/mobile-preview/README.md`，手册只给安装入口）。

**页数上限**：6 页每语言。内容装不下时先删，不拆页 —— 上一轮 12 页每语言的教训是
页越多越难查，且维护成本翻倍。

## 既有文档与去重策略

盘点时间 2026-09-20。上一轮没有这一节 —— 结果是手册 54KB 讲了 README 23KB 已经讲过的事。

| 文档 | 它覆盖什么 | 关系 | 处理动作 |
|---|---|---|---|
| `README.md`（23KB，英文） | Install / Use / 每个命令的完整参数 / 国内网络实测 / 远程会话触发 / Design / Security | **取代** | 瘦身为入口：保留项目定位、一条最短安装路径、双语手册链接、Design/Security 的一句话摘要 + 链接。命令细节与用法整段删除，迁入手册 |
| `plugins/mobile-preview/README.md` | 插件与 hooks 的安装说明 | 引用 | 手册的插件章节链过去，不复述 hooks 配置 |
| `skill/SKILL.md` | 给 AI Agent 的任务索引 | 无关 | 受众是 Agent 不是人，手册不覆盖 |
| `docs/superpowers/specs|plans|research/` | 设计推导、威胁模型、实施计划 | 无关 | 面向开发者，手册只在安全页引用结论 |
| `docs/guide/`（上一轮产物） | 与本次手册同内容 | 取代 | 返工后整目录重出 |

## 待确认问题

| 编号 | 问题 | 为何必须由用户决定 |
|---|---|---|
| Q1 | 手册的发布形态与落盘位置 | skill 的标准产物是 `docs/.doc-automation/publish/` 下的多页 Diátaxis 结构；但用户要的是「在开源仓库里能对外给出的一个地址」，两者路径观感差别很大，且决定后续是否拆页 |
| Q2 | 范围是否含三块进阶能力 | 已决：全含。README 被取代后，手册是唯一面向用户的文档，漏写等于功能消失 |
| Q3 | 中英双语的组织方式 | 已决：`publish/` 中文 + `publish/en/` 英文，一一对应（门禁校验镜像完整性） |
| Q4 | 手册与 `README.md` 的关系（取代 / 引用） | **本轮必答**。取代=README 瘦身成入口，手册写全，单一真源；引用=README 不动，手册只补它缺的小白路径。直接决定页数预算与 README 是否要改 |

> 四项均已由用户答复（2026-09-20 第二轮）。P0 通过，进入 P1。
>
> 本次未覆盖清单（交付时随报告给出，供用户点单追加）：
> `mp interaction` 的页面 HTML 编写规范（已在 `skill/SKILL.md` 与 interaction-page-contract 规格里）、
> hooks 的三个触发点配置细节、国内网络的完整实测数据表（README 保留该段）。
