---
name: mobile-preview
description: Use when a user needs a temporary authenticated tunnel to view a locally running app on a phone and capture screenshots inline.
---

# mobile-preview

Use `mp start` to expose the local app, `mp capture` to collect screenshots and diagnostics, and `mp stop` to tear everything down. Video capture requires `ffmpeg` on `PATH`.

## When to use

- The user just changed frontend code and wants to verify it on a phone.
- The user asks what the app looks like now.
- You need to check a page yourself before handing results back.

## Workflow

1. Start the target app locally.
2. Run `mp start --port <port>`.
3. Run `mp capture` or `mp capture <url> --steps <file> --video`. Use `--video` only when `ffmpeg` is available.
4. Paste the markdown image lines from capture output back into the reply.
5. Run `mp stop` after the user is done.

## Rules

- Never point `--port` at the preview tool itself, ChatGPT, or any terminal.
- Keep the tunnel temporary.
- Do not share any token except through the CLI output.
