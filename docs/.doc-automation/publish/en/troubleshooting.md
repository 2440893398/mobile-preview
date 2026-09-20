---
title: Troubleshooting
description: Find the cause of an mp problem from the symptom you see, and the action that fixes it
doc_type: how-to
module: Troubleshooting
audience: Users who are stuck
updated_at: 2026-09-20
source_evidence: [E001, E003, E004, E008, E009, E011]
source_anchors:
  - path: src/doctor.js
    fingerprint: sha256:cf37d173b817c2e3
---

# Troubleshooting

When stuck, run `mp doctor` first. It tells apart "not installed", "installed but this shell
cannot see it" and "only ffmpeg is missing", and prints the command that fixes each
(evidence E008).

## The command itself will not run

| Symptom | Cause | Action |
|---|---|---|
| Typing `mp` in PowerShell runs something else | `mp` is the built-in alias for `Move-ItemProperty` | Use `mp.cmd`, or `& mp` in a shell with the alias removed |
| `command not found` | The shell fixed its search path at startup and cannot see a freshly linked command | Close the terminal and open a new one |
| `mp doctor` reports cloudflared missing | The tunnel client is not installed | `winget install --id Cloudflare.cloudflared` on Windows, `brew install cloudflared` on macOS |
| `mp capture` reports no browser | Playwright's Chromium is not installed | `npx playwright install chromium` |
| `--video` produces no MP4 | ffmpeg is not on PATH | Install ffmpeg; without recording you can leave it missing |

## The preview will not come up, or will not open

| Symptom | Cause | Action |
|---|---|---|
| Hangs after `asking trycloudflare.com for a quick tunnel`, then fails | No working path to Cloudflare | Read `%LOCALAPPDATA%\mobile-preview\previews\<port>.cloudflared.log`; retries are separated by `--- attempt N/M ---` |
| The link printed, the phone shows 530 | The tunnel dropped after coming up | Run `mp start` again; mp does not reconnect on its own |
| The phone shows 404 | The link lost its token, or it expired | Take the current full link from `mp status` and send all of it, not just the domain |
| Blank on the phone, fine on the desktop | The page hardcodes `http://127.0.0.1` or `http://localhost` for its API, which on a phone means the phone | Use a relative `/api` path so requests travel through the tunnel |
| Edits do not show on the phone | The tunnel does not forward WebSocket upgrades, so hot reload is dead | Refresh the phone by hand |
| An SSE page looks broken | Same cause; events pile up until the connection closes | Verify that feature locally, or poll instead inside a preview |

## The command refuses to act

`mp` never guesses between candidates. That is design, not a fault:

```text
$ mp capture
several previews are active (ports 4173, 4180). Pass --port to pick one.

$ mp interaction wait --timeout 5
several interactions are open (i-2b944d, i-f1ed0b); pass --id.
```

Both are real output (evidence E009, E011). Pass `--port <n>` or `--id <id>` explicitly; run
`mp status` or `mp interaction status` first when you do not know the candidates.

When `mp interaction ask` refuses to issue a link, it lists each rule the page fails, such as
`nothing carries data-mp-submit, so the page has no way to submit`. Fix and rerun; a failing
page never goes live.

## The phone submitted and the page says it did not go through

Read which of the three the page is saying (the page's own text is Chinese):

- **"正在自动重试（n/5）" — retrying.** The tunnel is most likely reconnecting. Leave it alone
  and do not reload: the submission is resent five times over about half a minute, and the
  receipt appears once one gets through. Nothing that was filled in is lost.
- **"用下面这段话直接回给 AI" — the retries ran out.** The page has already turned the answer
  into a block of copyable text starting `【mp interaction 回传 · i-xxxxxx`. Copy it and paste
  it into the chat; that counts as answering, and no new link is needed.
- **"这个页面不是最新的了" — the question was asked again.** Go back to the chat for the
  current link.

To see what actually broke, read that question's tunnel log — `mp interaction status` prints
the path. `Lost connection with the edge` followed by `Registered tunnel connection` is the
window the submission fell into (evidence E009).

## You cannot find where the preview is

A preview runs in the background with no window, so nothing appears on the desktop.
`mp status` is the only place it is visible, giving the link, the remaining time, the daemon
and cloudflared process ids, and that port's tunnel log path (evidence E009; where each
artifact lands is in evidence E004).

Killing the daemon outright leaves an orphan cloudflared. `mp status` and `mp stop` reclaim
those before they report, and `mp stop --all` clears even unreadable slots.

## Networks in mainland China

`trycloudflare.com` is reachable directly but unstable there, and the first tunnel sometimes
needs a few retries. Measurements and advice are in the repository `README.md`, under
Running from mainland China (evidence E001).

## Still stuck

Open an issue with three things: the full output of `mp doctor`, the full output of
`mp status`, and the last 50 lines of the `.cloudflared.log` for that port.
