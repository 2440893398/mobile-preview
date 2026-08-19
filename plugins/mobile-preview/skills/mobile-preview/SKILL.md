---
name: mobile-preview
description: Use when a user wants Codex to expose a locally running web app on a phone, inspect the current mobile UI, capture screenshots, or stop a temporary preview.
---

# Mobile Preview

Use the installed `mp` CLI to give the user a temporary, token-gated URL for a
local web app. The plugin is project-agnostic: first identify the app's local
HTTP port, then use that port with `mp`.

## Prerequisites

The user must have completed the one-time setup in the mobile-preview tool
repository:

```powershell
npm install
npx playwright install chromium
winget install --id Cloudflare.cloudflared
npm link
```

Run `mp.cmd doctor` — or the plugin's `scripts/check-prerequisites.mjs` when the
CLI itself may be missing — before guessing at a setup problem. It reports each
prerequisite separately with the command that fixes it, and in particular tells
"the CLI was never linked" apart from "it is linked but this shell's PATH
predates the link", which look identical from the outside.

On Windows PowerShell, use `mp.cmd` instead of `mp`: PowerShell has an `mp`
alias for `Move-ItemProperty`. In Command Prompt, Git Bash, and other shells,
`mp` is fine.

## Workflow

1. Start the target app locally and confirm its port.
2. Run `mp.cmd start --port <port>` for a built app, or `mp.cmd start --port <port> --dev` for a Vite/Webpack development server in PowerShell.
3. Return the printed preview URL as a **bare line of its own**. Never wrap it
   in a code block, backticks, or any other markdown: many phone clients render
   code blocks unselectable and unclickable, and a link the user cannot copy is
   a link that never arrives. This has already cost one session.
4. Use `mp status` to inspect active previews.
5. Use `mp capture --port <port>` when a screenshot or browser diagnostics are needed.
6. Use `mp stop --port <port>` when the user is finished.

`mp.cmd start` narrates the stage it is waiting on and returns a link only after
cloudflared has registered an edge connection — a url on its own is not a
reachable preview and shows up as HTTP 530 on the phone. If it times out, the
message says whether the daemon is still trying; `mp.cmd status` then reports
whether it got there. Use `mp.cmd start --json` when the URL is going to be
parsed rather than read.

When diagnosing a blank dev-server preview, inspect the `FAILED REQUESTS`
section from `mp capture`: each entry includes the full URL, status code, and
resource type, and console-only resource errors are folded in with the URL they
refer to. Favicons and source maps are listed separately as ignorable. A Vite
module URL containing `?t=<timestamp>` is not a preview token when a valid
`mp_session` cookie is present, and is forwarded normally.

For a screen that only exists after an API call, use
`mp.cmd capture --network-idle` or `mp.cmd capture --wait-for "<selector>"`;
add `--full-page` to see past the first screen and `--strict` to make a page
with errors fail the command.

Use short lifetimes for sensitive apps, for example:

```powershell
mp.cmd start --port 8080 --dev --ttl 120 --grace 20
```

## Frontend development

When a frontend dev server calls an API at `127.0.0.1`, remember that the
browser on the phone treats `127.0.0.1` as the phone itself. Prefer relative API
URLs such as `/api/...` and configure the local dev server to proxy them to the
backend.

The preview does not forward WebSocket upgrades, so HMR does not work through
it at all — this is not a flaky-connection problem to retry. After a code
change, tell the user to reload the page on the phone.

Repeat captures never overwrite each other: screenshots are numbered
`shot-1.png`, `shot-2.png`, … within a preview's gallery, so a link already
sent to the phone keeps showing what it showed when it was sent.

## Safety

- Never expose a terminal, ChatGPT, or the preview tool itself.
- Treat the URL — now issued as `?__mp_token=<token>`, with the older `?t=`
  form still accepted for links already sent — as a bearer credential.
- Do not share the token or preview URL with anyone who should not access the app.
- Stop the preview when finished.
- Do not use this workflow to access data without authorization.
