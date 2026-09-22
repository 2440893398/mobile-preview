---
title: 排错
description: 按你看到的症状定位 mp 的问题，并拿到对应的处置动作
doc_type: how-to
module: 排错
audience: 卡住了的使用者
updated_at: 2026-09-20
source_evidence: [E001, E003, E004, E008, E009, E011]
source_anchors:
  - path: src/doctor.js
    fingerprint: sha256:834ebe2efcc3fbfe
---

# 排错

卡住时第一件事永远是 `mp doctor`。它会分辨"没装"、"装了但当前终端看不见"、
"只缺录像用的 ffmpeg"三种情况，并直接给出修复命令（证据 E008）。

## 命令本身跑不起来

| 症状 | 原因 | 处置 |
|---|---|---|
| PowerShell 里敲 `mp` 执行了别的东西 | `mp` 是 `Move-ItemProperty` 的内置别名 | 改用 `mp.cmd`；或在去掉别名的 shell 里用 `& mp` |
| `command not found` / 不是内部或外部命令 | 终端启动时就固定了搜索路径，看不见刚装好的 `mp` | 关掉终端，开一个新的再试 |
| `mp doctor` 报 cloudflared 缺失 | 隧道程序没装 | Windows `winget install --id Cloudflare.cloudflared`，macOS `brew install cloudflared` |
| `mp capture` 报浏览器缺失 | Playwright 的 Chromium 没装 | `npx playwright install chromium` |
| `--video` 不出 MP4 | ffmpeg 不在 PATH 上 | 装 ffmpeg；不录像的话这一项可以一直缺着 |

## 预览开不出来或打不开

| 症状 | 原因 | 处置 |
|---|---|---|
| 一直停在 `asking trycloudflare.com for a quick tunnel` 后失败 | 到 Cloudflare 的网络不通 | 读 `%LOCALAPPDATA%\mobile-preview\previews\<端口>.cloudflared.log`，每次重试以 `--- attempt N/M ---` 分隔 |
| 链接打印出来了，手机打开 530 | 隧道建起来之后掉线 | 重新执行 `mp start`；本工具不做自动重连 |
| 手机打开 404 | 链接缺了口令，或已过期 | 用 `mp status` 取当前完整链接，整条发送，不要只发域名 |
| 手机上白屏，电脑上正常 | 页面里写死了 `http://127.0.0.1` 或 `http://localhost` 的接口地址，在手机上指向手机自己 | 改成相对路径 `/api`，让请求走隧道 |
| 改了代码手机上不更新 | 隧道不转发 WebSocket 升级，热更新不工作 | 在手机上手动刷新 |
| 依赖 SSE 的页面像是坏了 | 同上，事件堆积到连接关闭才送达 | 预览里改用轮询验证，或只在本机验证该功能 |

## 命令拒绝执行

`mp` 在有多个候选时不会替你猜，这不是故障：

```text
$ mp capture
several previews are active (ports 4173, 4180). Pass --port to pick one.

$ mp interaction wait --timeout 5
several interactions are open (i-2b944d, i-f1ed0b); pass --id.
```

两条都是真实输出（证据 E009、E011）。处置是显式加 `--port <n>` 或 `--id <id>`；
不确定有哪些时先跑 `mp status` / `mp interaction status`。

`mp interaction ask` 拒绝出链接时，它会把页面不合规的条目逐条列出来，例如
`nothing carries data-mp-submit, so the page has no way to submit`。照着改再跑一次即可，
不合规的页面不会上线。

## 手机上点了提交，页面说没送出去

先看页面在说哪一种：

- **"正在自动重试（n/5）"** —— 隧道多半正在重连，不用管，也不要刷新页面。半分钟内重发
  五次，成了就出回执；填的内容一直都在。
- **"用下面这段话直接回给 AI"** —— 重试用完了。页面已经把答案变成一段可复制的文字，
  开头是 `【mp interaction 回传 · i-xxxxxx`。复制它，粘贴回和 AI 的对话里发出去，这就算
  答过了，不用重新要链接。
- **"这个页面不是最新的了"** —— 问题已经被重新问过一遍，回聊天里要最新的那条链接。

想知道当时到底断在哪，看这个问题的隧道日志：`mp interaction status` 会打印路径，
日志里的 `Lost connection with the edge` 和随后的 `Registered tunnel connection` 就是那段
空窗（证据 E009）。

## 找不到预览在哪

预览跑在后台，没有窗口，桌面上不会出现任何东西。`mp status` 是唯一能看到它的地方，
它给出链接、剩余时间、守护进程与 cloudflared 两个进程号，以及该端口的隧道日志路径
（证据 E009；各产物的落盘位置见证据 E004）。

强杀守护进程会留下孤儿 cloudflared。`mp status` 与 `mp stop` 在报告之前会顺手回收它们，
`mp stop --all` 连状态异常的槽位一起清掉。

## 国内网络

`trycloudflare.com` 在国内可直连但不稳定，首次建隧道偶尔需要重试几次。
实测数据与建议见仓库 `README.md` 的 Running from mainland China 一节（证据 E001）。

## 还是不行

带上三样东西提 issue：`mp doctor` 的完整输出、`mp status` 的完整输出、
以及对应端口的 `.cloudflared.log` 最后 50 行。
