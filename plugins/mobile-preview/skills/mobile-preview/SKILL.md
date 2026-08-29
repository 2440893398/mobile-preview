---
name: mobile-preview
description: Use whenever a locally running app has to be opened, shown, verified or screenshotted by someone who is not at this machine — every time a localhost or 127.0.0.1 URL would otherwise be handed to the user, and in any remote session (Happy, phone) where such an address cannot be opened at all. Triggers on "on my phone", "手机上看看", "看看效果", "preview", "预览一下", "send me the link", "把链接发我", "screenshot", "截图", "mobile UI", "localhost 打不开", "这个地址打不开", "stop the preview", "关掉预览", and on mp start / mp capture / mp stop.
---

# Mobile Preview

Use the installed `mp` CLI to give the user a temporary, token-gated URL for a
local web app. The plugin is project-agnostic: first identify the app's local
HTTP port, then use that port with `mp`.

## Remote sessions

A session started through Happy is a phone session: the person asking is not at
this machine, so `http://localhost:<port>` is not an answer they can act on — on
their device that address is the phone. In such a session this workflow is not
one option among several; it is the only way a local app can be handed over, and
it applies even when the user never names the plugin. The plugin's SessionStart
hook detects such a session and says so at the top of the conversation, on
Claude Code and Codex alike; under any other host, notice it yourself.

The signal is the environment, not the phrasing: `CLAUDE_CODE_EXECPATH` pointing
inside Happy's npm package, or a `HAPPY_*` variable, or
`CLAUDE_CODE_ENTRYPOINT=remote_mobile`. Do not test for the string "happy"
anywhere in the environment — a machine that has Happy installed carries it in
`NO_PROXY` and `PATH`, which makes every local session look remote. A Codex
session carries none of those, so there the hook reads the process tree, in
which the happy CLI is an ancestor.

If the notice never appears in a Codex session that clearly is remote, the
likely cause is hook trust: Codex reviews new and modified hooks at startup and
skips them until they are trusted, without saying so during the session.

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

1. Start the target app locally and confirm its port. Start it detached — see
   *Starting the app* below.
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

## Starting the app

Step 1 is where a preview session goes wrong hours after it looked finished.
Start the user's app as a genuinely detached process:

```powershell
Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList "/c", "npm run dev" -WorkingDirectory <app-dir> -RedirectStandardOutput <log>
```

Do not start it as a tracked background task. A tracked task holds the turn open
for as long as the process lives, and when the process finally dies — hours
later, on a crash nobody is watching — its exit notification wakes the
conversation back up and the original request gets answered a second time. One
session started a backend and a dev server as tracked tasks, stopped only the
dev server before handing over the link, and was resurrected five and a half
hours later when the backend hit a Windows socket error. The user saw a single
turn that had apparently "worked" for 5h28m and then re-issued its first answer.

If a tracked background task is unavoidable, stop every one of them before
returning the link. Leaving one behind is what causes the delayed replay.

`mp` itself is safe here: the daemon is spawned detached with its stdio
discarded, so the harness never tracks it and it expires quietly at the end of
its TTL.

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
