---
title: 快速上手
description: 从零装好 mp，并拿到一条手机上能直接打开的本地应用预览链接
doc_type: tutorial
module: 入门
audience: 第一次使用的开发者
updated_at: 2026-09-20
source_evidence: [E002, E003, E008, E009]
prerequisites:
  - 已安装 Node.js 20 或更高版本
  - 本机有一个能跑起来的网页项目，并知道它监听的端口
related:
  - ./workflows/preview-and-capture.md
  - ./troubleshooting.md
source_anchors:
  - path: src/doctor.js
    fingerprint: sha256:834ebe2efcc3fbfe
  - path: package.json
    fingerprint: sha256:1a8daa9736f04496
---

# 快速上手

```mermaid
flowchart LR
  A["1 装<br/>npm i -g<br/>mobile-preview-cli"] --> B["2 验<br/>mp doctor"] --> C["3 开<br/>mp start --port"] --> D["4 手机打开<br/>链接即密码"] --> E["5 关<br/>mp stop"]
```

五步，约十分钟，终点是一条手机上能打开的链接。

## 前置条件

- 已安装 Node.js 20 或更高版本，`node -v` 能打印版本号
- 本机有一个能跑起来的网页项目，并且知道它监听的端口
- Windows PowerShell 用户：下面所有 `mp` 都写成 `mp.cmd`

## 安装 mp 的步骤

起点：一个可以执行命令的终端窗口，当前目录随意。

1. 装 mp：`npm i -g mobile-preview-cli`。
2. 装截图用的浏览器：`npx playwright install chromium`。
3. 装隧道程序：Windows 上 `winget install --id Cloudflare.cloudflared`，
   macOS 上 `brew install cloudflared`。
4. 关掉当前终端，**开一个新的**，执行 `mp doctor`。
   - 预期：四项都打印 `ok`，末尾一行 `Everything mp needs is present.`（证据 E008）。

包名是 `mobile-preview-cli`，装好以后的命令名是 `mp`：npm 上 `mobile-preview` 这个名字
已被另一个包占用。

新终端这一步不能省：系统的可执行文件搜索路径在终端启动时就固定了，旧窗口看不见刚装好的
`mp`。

想跟着源码走（改代码或跟进 main），把第 1 步换成
`git clone https://github.com/2440893398/mobile-preview.git`、`cd mobile-preview`、
`npm install`、`npm link`，其余步骤不变。

## 跑通第一次预览的步骤

起点：`mp doctor` 四项全 `ok`，你的应用已在本机跑起来（例如监听 4173）。

1. 执行 `mp start --port 4173`，把 4173 换成你的应用真实监听的端口。
   - 预期：依次打印 `... starting the preview daemon` 与
     `... asking trycloudflare.com for a quick tunnel`，只有真正连上才打印链接（证据 E009）。
2. 把打印出来的那条链接发到手机上打开。
   - 预期：手机浏览器里出现的就是你本机跑着的那个应用。
3. 看完后执行 `mp stop`。
   - 预期：`stopped port 4173 (2 process tree(s) terminated)`；手机上再刷新就打不开了
     （证据 E009）。

不执行 `mp stop` 也可以，预览默认 30 分钟后自动结束。

## 验证

执行 `mp status`。跑通的标志是：`mp start` 之后它列出该端口的槽位，带链接、剩余时间、
两个进程号与隧道日志路径；`mp stop` 之后该槽位从列表消失。

预览没有窗口，桌面上不会出现任何东西，`mp status` 是唯一能看到它的地方。

## 失败时

先执行 `mp doctor`，它会分别告诉你是没装、还是装了但当前终端看不见、还是只缺录像用的
ffmpeg，并直接给出修复命令。

若 `mp start` 等待后失败，完整日志在
`%LOCALAPPDATA%\mobile-preview\previews\<端口>.cloudflared.log`，每次重试以
`--- attempt N/M ---` 分隔。

按症状查处置见[排错](./troubleshooting.md)。
