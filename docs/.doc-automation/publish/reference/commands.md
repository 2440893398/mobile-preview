---
title: 命令速查
description: 查 mp 每条命令的参数、默认值与取值范围，以及插件安装入口
doc_type: reference
module: 参考
audience: 已经上手、需要查参数的使用者
updated_at: 2026-09-20
source_evidence: [E002, E012]
source_anchors:
  - path: src/usage.js
    fingerprint: sha256:4a1b564592bd5b27
---

# 命令速查

本页逐字对照 `mp --help` 与各子命令的 `--help` 原文生成（证据 E012），默认值取自
`src/usage.js`（证据 E002）。Windows PowerShell 里所有 `mp` 写成 `mp.cmd`。

全局：`-h, --help` 显示帮助，`mp <命令> --help` 显示单条命令的选项；
`-v, --version` 打印版本号。未知选项会被按名字拒绝，不会被悄悄忽略。

## 命令总览

| 命令 | 作用 | 最常用的参数 |
|---|---|---|
| `mp start` | 把本地端口开成临时的带口令公网链接 | `--port` `--ttl` `--dev` |
| `mp capture` | 按手机尺寸截图，并报告页面上出了什么错 | `--port` `--full-page` `--network-idle` |
| `mp status` | 列出活跃预览与各自剩余时间 | `--json` |
| `mp stop` | 拆掉预览，并确保没有残留进程 | `--port` `--all` |
| `mp doctor` | 检查 mp 需要的东西是否都已安装、在 PATH 上、可达 | 无 |
| `mp secret ask/wait/run/status/forget` | 手机填凭据，AI 可用但读不到 | `--field` `--use` `--id` |
| `mp interaction ask/wait/status/close` | 把一个决定做成页面，答案以 JSON 回来 | `--html` `--id` `--timeout` |

## mp start

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port <n>` | 5173 | 要暴露的本地端口，即你的应用已经监听的那个 |
| `--ttl <min>` | 30 | 预览自行终止前的分钟数，取值 1 到 1440 |
| `--grace <min>` | 与 `--ttl` 相同 | 链接首次使用后仍可换取会话的分钟数；`0` 为一次性 |
| `--dev` | 关闭 | 暴露开发服务器而非构建产物，攻击面更大 |
| `--json` | 关闭 | 在标准输出打印一个机器可读的 JSON 对象，而非人读文本 |

## mp capture

用法是 `mp capture [url] [options]`，不带 url 时拍预览首页。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port <n>` | 唯一活跃的那条 | 通过哪条预览去拍 |
| `--device <name>` | iPhone 13 | Playwright 设备档案，例如 `"Pixel 7"`、`"iPhone 15 Pro"` |
| `--steps <file>` | 无 | 默认导出 `async (page) => {}` 的 ESM 文件，截图前执行 |
| `--video` | 关闭 | 把过程录成 MP4，需要 ffmpeg 在 PATH 上 |
| `--wait-for <selector>` | 无 | 等到该 CSS 选择器可见再拍 |
| `--wait-ms <n>` | 500 | 页面稳定后额外等待的毫秒数 |
| `--network-idle` | 关闭 | 等网络静默而不只是 load，给 API 驱动的单页应用用 |
| `--full-page` | 关闭 | 拍整个可滚动页面，而不只是第一屏 |
| `--strict` | 关闭 | 页面有控制台报错或失败请求时以非零退出码结束 |

`mp status` 的 `--json` 与 `mp stop` 的 `--port` / `--all` 语义同上；`--all` 会把陈旧和
读不出来的槽位一并停掉。

## mp secret

值只存在于各自守护进程的内存里。`status` 与 `wait` 永远只报字段名与指纹，不报值。

| 子命令 | 关键参数 | 默认 | 说明 |
|---|---|---|---|
| `secret ask` | `--purpose <text>` | 无 | 表单顶部的一行说明：这些值拿来干什么 |
| | `--field <NAME[:kind]>` | kind 为 `secret` | 要收集的字段，可重复。`secret` 掩码且从输出中脱敏，`text` 可见不脱敏，`multiline` 为文本域 |
| | `--use <command>` | 无 | AI 打算用这些值跑的命令，可重复；由你在手机上逐条勾选 |
| | `--id <id>` | 无 | 让已有槽位追加批准更多 `--use`，不必重新输入值 |
| | `--ttl <min>` | 120 | 值到达后在内存中保留的分钟数，取值 1 到 1440 |
| | `--form-ttl <min>` | 30 | 表单链接开放的分钟数，取值 1 到 60 |
| `secret wait` | `--timeout <sec>` | 540 | 放弃等待前的秒数；链接不受影响仍然开着 |
| `secret run` | `--cwd <dir>` | 当前目录 | 命令的工作目录。用法是 `mp secret run [options] -- <命令…>` |
| `secret forget` | `--all` | 关闭 | 清掉每个槽位，包括陈旧的 |

## mp interaction

| 子命令 | 关键参数 | 默认 | 说明 |
|---|---|---|---|
| `interaction ask` | `--html <file>` | 无 | 要发布的页面，单个自包含 HTML，不引外部资源；发链接前先做校验 |
| | `--purpose <text>` | 无 | 一行说明，供 `mp interaction status` 显示 |
| | `--id <id>` | 无 | 用新页面替换某个未关闭问题的页面，修订号加一 |
| | `--ttl <min>` | 120 | 答案到达后可读的分钟数，取值 1 到 1440 |
| | `--form-ttl <min>` | 30 | 链接开放的分钟数，取值 1 到 60 |
| `interaction wait` | `--timeout <sec>` | 540 | 超时即报告"仍在等待"并以退出码 0 结束，链接仍开着 |
| `interaction close` | `--all` | 关闭 | 关掉每个问题，包括陈旧的 |

## 装成插件

让 AI 自己想到用这些命令，而不用你每次手敲，安装步骤与三个 hook 的说明在
[插件说明](https://github.com/2440893398/mobile-preview/blob/main/plugins/mobile-preview/README.md)。
装好之后，远程会话里提到「手机上看看」「截图」「把链接发我」这类说法就会自动触发。

> 这里用的是仓库绝对地址而不是相对路径：本页会被镜像到 `docs/guide/` 下，
> 目录深度和 `publish/` 不同，跨出手册目录的相对路径镜像后会断。
