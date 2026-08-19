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

1. Start the target app locally, detached — see the rule below.
2. Run `mp start --port <port>`. It prints the stage it is waiting on and only
   returns a link once cloudflared has registered with the edge; `mp start --json`
   gives `{status, url, port, expiresAt}` for programmatic use.
3. Run `mp capture` or `mp capture <url> --steps <file> --video`. Use `--video` only when `ffmpeg` is available.
4. Paste the markdown image lines from capture output back into the reply, and
   the preview URL as a bare line of its own.
5. Run `mp stop` after the user is done.

If anything refuses to start, run `mp doctor` before guessing: it separates a
missing CLI from a CLI that is installed but not on this shell's PATH, and both
from a missing cloudflared, browser or ffmpeg.

For an app whose first screen is rendered after an API call, use
`mp capture --network-idle` or `mp capture --wait-for "<selector>"` rather than
accepting whatever was on screen half a second after load. `--full-page`
captures past the first screen, and `--strict` makes the command fail when the
page had console errors or failed requests.

## Rules

- **Start the app detached, never as a tracked background task.** Use
  `Start-Process -WindowStyle Hidden` on Windows or `nohup ... &` elsewhere. A
  tracked background task holds the turn open for as long as the process lives,
  and its exit notification — arriving hours later when the process crashes
  unattended — wakes the conversation up and answers the original request a
  second time. One session left a backend running that way and was resurrected
  five and a half hours later, replaying its own first reply. If a tracked task
  is unavoidable, stop every one of them before returning the link. `mp`'s own
  daemon is detached with its stdio discarded and never does this.
- **Output the preview link as a bare line.** Never wrap it in a code block,
  backticks, or any other markdown. Many phone clients render code blocks
  unselectable and unclickable, and a link the user cannot copy is a link that
  never arrives. This has already cost one session.
- The link stays exchangeable for `--grace` minutes (default 10) after its
  first use, so a chat client that prefetches it does not lock the user out.
  After that only the cookie works. Do not hand the same link to two people
  expecting both to get in.
- Links are issued as `?__mp_token=<token>`. The older `?t=<token>` form is
  still accepted for links already in someone's history, but never issue it:
  Vite uses `?t=<timestamp>` for its own module URLs, and a valid session is
  allowed to request those.
- Treat the whole preview URL as a bearer credential.
- Never point `--port` at the preview tool itself, ChatGPT, or any terminal.
- Keep the tunnel temporary.
- Do not share any token except through the CLI output.
