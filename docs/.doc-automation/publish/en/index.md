---
title: mobile-preview manual
description: See the three problems mp takes off your hands, and pick the page to read first
doc_type: explanation
module: Overview
audience: Developers who have not installed it yet and are deciding whether to
updated_at: 2026-09-20
source_evidence: [E001, E002, E007, E010]
---

# mobile-preview manual

中文版：[中文手册](../index.md)

## Where you are stuck today

```mermaid
flowchart LR
  subgraph now["Today"]
    A1["Send localhost:5173<br/>to a phone"]
    A2["Paste a credential<br/>into the chat"]
    A3["Write three options<br/>as a wall of text"]
  end
  subgraph after["With mp"]
    B1["A temporary link with a token<br/>opens your app on the phone"]
    B2["The value is typed on the phone<br/>usable by the AI, never readable"]
    B3["One page of tappable choices<br/>the answer comes back as JSON"]
  end
  A1 -->|"on their device<br/>localhost means themselves"| B1
  A2 -->|"chat history and logs<br/>each keep a copy"| B2
  A3 -->|"they scroll three screens<br/>then type a reply"| B3
```

## One job, one command

| What you want | Command | What you get |
|---|---|---|
| Open the local app on a phone | `mp start` | An HTTPS link carrying a token, closing itself after 30 minutes by default |
| Let the AI use a credential it cannot read | `mp secret ask` | The value is typed on the phone, injected into the command, scrubbed from output (evidence E005) |
| Ask a question without a wall of text | `mp interaction ask` | A tappable page on the phone; the answer returns as JSON |
| Let the AI reach for these on its own | Install the plugin | No command typing in a remote session (evidence E001) |

## What it looks like on the phone

Evidence E010:

![The demo app at phone size: heading "演示应用", subtitle "跑在本机 127.0.0.1:4173", four order rows, and a green button](../assets/screenshots/phone-preview-demo.png)

Legend: this image is a real artifact produced by `mp capture`, not a mockup.

## What to read, in what order

| Where you are | Read this |
|---|---|
| Nothing installed yet | [Quickstart](./quickstart.md) |
| Installed, want daily use | [Show the app on a phone](./workflows/preview-and-capture.md) |
| The AI needs your credential, or needs you to choose | [Credentials and decisions](./workflows/secrets-and-decisions.md) |
| Looking up a flag | [Command reference](./reference/commands.md) |
| Something broke | [Troubleshooting](./troubleshooting.md) |

## Two things to know first

**In Windows PowerShell, write `mp.cmd`.** PowerShell takes `mp` as an alias for the built-in
`Move-ItemProperty`, so a bare `mp` runs something unrelated. CMD, Git Bash, macOS and Linux
take `mp` directly; this manual writes `mp` throughout, and PowerShell readers substitute.

**The link is the password.** Every link carries a 32-byte token, and without it every request
gets a 404 (evidence E007). Forwarding the link hands over the preview; there is no second
login.

## Scope

**Covered**: installation and self-check, previews, screenshot and video diagnostics, the
credential relay, decision pages, every command flag, troubleshooting.

**Not covered**: source architecture, contribution flow and design rationale, which live in
`README.md` and `docs/superpowers/specs/`; the plugin hook configuration, which lives in
`plugins/mobile-preview/README.md`.

This manual is written against 0.5.3. Run `mp --version` for the one you have (evidence E002).
