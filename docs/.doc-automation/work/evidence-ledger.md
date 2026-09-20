# 证据台账

等级：A（需求/规范）、B（代码/配置）、C（运行时观测）。
本轮与上一轮的区别：上一轮零 C 级证据，所有「预期」都是读源码推断的；本轮全部命令真跑过一遍。

| 编号 | 章节 | 证据类型 | 等级 | 文件路径 | 采集原因 | 时间戳 |
|------|------|----------|------|----------|----------|--------|
| E001 | 全局 | 规范文档 | A | README.md | 国内网络实测数据与安全约束的权威来源 | 2026-09-20 |
| E002 | 命令与参数 | 源码 | B | src/usage.js | 所有命令、参数与默认值的唯一真源 | 2026-09-20 |
| E003 | 安装与自检 | 源码 | B | src/doctor.js | 各依赖的检测分支与修复命令原文 | 2026-09-20 |
| E004 | 产物路径 | 源码 | B | src/state.js | 预览状态、隧道日志、截图目录的落盘位置 | 2026-09-20 |
| E005 | 密钥中继 | 设计规格 | A | docs/superpowers/specs/2026-09-11-secret-relay-design.md | 加密链路与威胁模型边界 | 2026-09-20 |
| E006 | 决策页 | 设计规格 | A | docs/superpowers/specs/2026-09-16-interaction-page-contract.md | 页面合同的硬性要求 | 2026-09-20 |
| E007 | 安全边界 | 源码 | B | src/proxy.js | 鉴权失败一律 404、产物路径的 token 校验 | 2026-09-20 |
| E008 | 安装与自检 | 终端实录 | C | assets/transcripts/doctor.txt | 决策树条件 5 不适用；`mp doctor` 的预期输出必须真跑，不得照抄源码分支 | 2026-09-20 |
| E009 | 预览生命周期 | 终端实录 | C | assets/transcripts/preview-lifecycle.txt | start/status/capture/stop 四步的真实输出；含「两条预览时 capture 拒绝猜」这一只有真跑才会遇到的分支 | 2026-09-20 |
| E010 | 手机上看到的样子 | 截图 | C | publish/assets/screenshots/phone-preview-demo.png | 决策树条件 1：小白需要先看见"预览到底长什么样"，文字描述不足；本图是 `mp capture` 的真实产物 | 2026-09-20 |
| E011 | 密钥与决策页 | 终端实录 | C | assets/transcripts/secret-and-interaction.txt | secret ask/status/forget 与 interaction ask/wait/close 的真实输出；含页面合同不满足时的拒绝原文 | 2026-09-20 |
| E012 | 命令速查 | 终端实录 | C | assets/transcripts/help.txt | 全部 `--help` 原文，命令速查表逐字对照它生成，避免转述走样 | 2026-09-20 |

## capture 清单

### E010

```yaml
replayable: true
tool: mp capture
setup: node docs/.doc-automation/assets/fixtures/demo/serve.mjs   # 演示页监听 127.0.0.1:4173
steps:
  - run: mp start --port 4173 --ttl 15
  - run: mp capture --port 4173
  - copy: "%LOCALAPPDATA%/mobile-preview/gallery/4173/<最新>.png"
  - run: mp stop --port 4173
output: publish/assets/screenshots/phone-preview-demo.png
device: iPhone 13（mp capture 默认）
mustShow:
  - 标题「演示应用」
  - 副标题「跑在本机 127.0.0.1:4173」
  - 「订单列表」四行与金额
  - 绿色「点我」按钮
blur: []
```

> 演示页是专门为取证造的（`assets/fixtures/demo/`），不含任何真实数据，因此无需脱敏。
> 它放在 `fixtures/` 而不是 `tmp/`：`tmp/` 发布后即可整目录删除，而重放这张截图需要它。
>
> **图片落在 `publish/assets/` 而不是工作区根的 `assets/screenshots/`**：`publish/` 要整体
> 镜像到 `docs/guide/`，两处目录深度不同，跨出 `publish/` 的相对路径镜像后会断。
> 让 `publish/` 自带资源，镜像就是纯拷贝，不需要改写任何链接，也不产生第二份图片。

## 终端实录规格

四份实录均由 PowerShell 逐条执行 `mp.cmd <命令>` 后追加落盘，重放方式就是照 `$` 行再跑一遍。
落盘前统一做过两件事：

1. `__mp_token=` 后的值与产物路径 `/_a/<hash>/` 一律替换为 `<token>`
2. 去掉 PowerShell 对 native 命令 stderr 的 `NativeCommandError` 包装行，只留 `mp` 自己的输出

文件头两行记采集时间与环境（OS、shell、node、mp 版本），换机器重放前先比对这两行。
