# 文档规划 — mobile-preview 操作手册（返工版）

> 阶段：P1（规划拆解）
> 时间：2026-09-20
> 上一轮产物：24 页（中英各 12），因重复 README、零图、零运行时证据被推倒重做

## 规模预算

| 项 | 内容 |
|----|------|
| 页数预算 | **6 页每语言**，中英共 12 个页面文件 |
| 最小集 | `index` · `quickstart` · `workflows/preview-and-capture` · `workflows/secrets-and-decisions` · `reference/commands` · `troubleshooting` |
| 扩展集 | `faq`（症状问答，与 troubleshooting 重叠，**默认不写**）· `explanation/security`（安全边界，折进 index 与 commands 的注意事项，**默认不写**）· `appendix/glossary`（术语表，术语首次出现即解释，**默认不写**）· `workflows/install-plugin`（插件安装，链回 `plugins/mobile-preview/README.md`，**默认不写**） |
| 依据 | 功能地图 8 条模块，收敛成 5 组命令（doctor / start-status-stop / capture / secret / interaction）；受众是第一次用的开发者，主线只有「装好 → 开预览 → 手机看」；skill 经验值对命令行小工具是 ≤ 5 页每语言，本次因 README 被取代需额外承接一页完整命令速查，故 6 页 |

> 上一轮是 12 页每语言。删掉的 6 页不是删内容：glossary 的 7 条术语改为首次出现即解释，
> security 折进 index 的「一件必须先知道的事」与 commands 的参数注意事项，
> faq 与 troubleshooting 合并，install-plugin 收进 commands 的末节并链回插件 README。

## 模块优先级

| 优先级 | 模块 | 承载页面 | 理由 |
|---|---|---|---|
| P0 | 安装与自检 | `quickstart` | 装不上就没有后面 |
| P0 | 预览生命周期（start/status/stop） | `quickstart`、`workflows/preview-and-capture` | 产品主线 |
| P1 | 截图与录像诊断 | `workflows/preview-and-capture` | 与预览同一场景，同页承载两个流程 |
| P1 | 排错 | `troubleshooting` | 小白卡住的落点 |
| P2 | 密钥中继 | `workflows/secrets-and-decisions` | 进阶，但 README 取代后必须有 |
| P2 | 决策页 | `workflows/secrets-and-decisions` | 同上；与密钥同属「AI 要你输入点什么」 |
| P2 | 全命令参数 | `reference/commands` | 承接被删掉的 README 命令段 |
| P3 | 插件与 hooks | `reference/commands` 末节 | 只给安装入口，细节链回插件 README |

## 批次计划

| 批次 | 内容 | 验收 |
|---|---|---|
| Batch-1 | 运行时取证：真跑 doctor / start / status / capture / stop / secret / interaction，落盘 `assets/transcripts/` 与 `assets/screenshots/` | 台账至少 4 条 C 级证据，截图真实存在 |
| Batch-2 | 中文 6 页 | `--phase p4` 的结构/契约/视觉三类检查对中文页全绿 |
| Batch-3 | 英文 6 页（与中文一一对应） | 双语镜像检查通过，英文页按英文契约措辞 |
| Batch-4 | README 瘦身 + 镜像到 `docs/guide/` + 提交 + 对外入口校验 | 门禁退出码 0，`对外入口` 检查通过 |

## 每批验收标准

- **Batch-1**：每条实录文件头两行带采集时间与环境；token 一律脱敏为 `<token>`；
  截图为 `mp capture` 的真实产物而非合成图
- **Batch-2**：每个流程页含 `## 前置条件` / `起点：` / 末步 `- 预期：` / `## 验证` / `## 失败时`，
  且至少一张图（Mermaid 或截图）；正文「预期」措辞与实录一致
- **Batch-3**：英文页用 `## Prerequisites` / `Start:` / `- Expected:` / `## Verify` / `## If it fails`，
  不混中文；页面路径与中文一一对应
- **Batch-4**：`docs/guide/` 已 `git add` 并提交；README 内所有手册链接指向已提交文件

## 依赖与风险

| 项 | 状态 | 处置 |
|---|---|---|
| `mp` CLI 可执行 | ✅ 已验证 `mp.cmd doctor` 四项全绿 | 直接取实录 |
| cloudflared 隧道 | ✅ 已就绪 | `mp start` 会真的建隧道，取证后立即 `mp stop` |
| Playwright MCP | ⚠️ 本会话连接超时 | 不影响：截图走 `mp capture`（工具自带 Playwright），非 MCP |
| Image Annotator MCP | 未使用 | 本次不做编号标注，截图直接用原图；无标注则无 `图例：` 要求 |
| 实录含 token | 风险 | 落盘前把 `__mp_token=` 后的值替换为 `<token>`，链接域名保留 |
| README 瘦身 | 风险 | 删掉的命令段必须在 `reference/commands` 里逐条对应，删前先比对清单 |
