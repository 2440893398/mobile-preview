---
title: mobile-preview 操作手册
description: 看懂 mp 替你解决的三件事，并挑到该读的第一页
doc_type: explanation
module: 总览
audience: 还没安装、正在判断要不要用的开发者
updated_at: 2026-09-20
source_evidence: [E001, E002, E007, E010]
---

# mobile-preview 操作手册

English version: [English manual](./en/index.md)

## 你现在是怎么卡住的

```mermaid
flowchart LR
  subgraph now["现在"]
    A1["把 localhost:5173<br/>发给手机"]
    A2["把密钥贴进聊天框"]
    A3["三个方案写成一屏字<br/>发出去等回话"]
  end
  subgraph after["装上 mp 之后"]
    B1["一条带口令的临时链接<br/>手机点开就是你的应用"]
    B2["值只在手机上填<br/>AI 用得上，读不到"]
    B3["手机上一页选择题<br/>答案以 JSON 回来"]
  end
  A1 -->|"手机上的 localhost<br/>指的是手机自己"| B1
  A2 -->|"聊天记录、日志<br/>各留了一份"| B2
  A3 -->|"对方滑三屏<br/>再打字回你"| B3
```

## 一件事对一条命令

| 你想做的 | 命令 | 拿到什么 |
|---|---|---|
| 让手机打开本机应用 | `mp start` | 一条带口令的 HTTPS 链接，默认 30 分钟后自动关闭 |
| 让 AI 用你的密钥但读不到 | `mp secret ask` | 值在手机上填，注入命令环境，输出脱敏（证据 E005） |
| 让一个选择题别变成一屏字 | `mp interaction ask` | 手机上一页可点的页面，答案以 JSON 回到 AI 手里 |
| 让 AI 自己想起来用这些 | 装插件 | 远程会话里不必你每次手敲（证据 E001） |

## 手机上看到的样子

证据 E010：

![手机尺寸下的演示应用，标题「演示应用」、副标题「跑在本机 127.0.0.1:4173」、订单列表四行与绿色「点我」按钮](./assets/screenshots/phone-preview-demo.png)

图例：这张图是 `mp capture` 拍下来的真实产物，不是示意图。

## 按什么顺序读

| 你的状态 | 读这页 |
|---|---|
| 还没装 | [快速上手](./quickstart.md) |
| 装好了，想天天用 | [把应用开给手机看](./workflows/preview-and-capture.md) |
| AI 要用你的密钥，或者要你做选择 | [交出密钥与做选择](./workflows/secrets-and-decisions.md) |
| 查参数 | [命令速查](./reference/commands.md) |
| 出问题了 | [排错](./troubleshooting.md) |

## 两件必须先知道的事

**在 Windows PowerShell 里命令要写成 `mp.cmd`。** PowerShell 把 `mp` 占用为内置命令
`Move-ItemProperty` 的别名，直接敲 `mp` 会执行完全无关的东西。CMD、Git Bash、macOS 与
Linux 直接写 `mp`；本手册统一写 `mp`，PowerShell 读者自行替换。

**链接即密码。** 每条链接里带一个 32 字节口令，没有它一律返回 404（证据 E007）。
把链接转发给谁，就等于把这个预览给了谁，它没有二次登录。

## 范围边界

**覆盖**：安装与自检、预览、截图与录像诊断、密钥中继、决策页、全部命令参数、排错。

**不覆盖**：源码架构、贡献流程、设计推导，这些在 `README.md` 与 `docs/superpowers/specs/`；
插件 hooks 的配置细节在 `plugins/mobile-preview/README.md`。

本手册基于 0.5.3 写成。你装的是哪一版，用 `mp --version` 查（证据 E002）。
