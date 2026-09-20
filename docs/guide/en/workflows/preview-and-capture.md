---
title: Show the app on a phone, and let the AI look at it
description: Open a preview link for your local app and use mp capture for phone-sized shots and page errors
doc_type: how-to
module: Preview
audience: Developers who already installed mp
updated_at: 2026-09-20
source_evidence: [E002, E009, E010]
prerequisites:
  - Quickstart done, mp doctor reports ok four times
  - Your app is running locally and you know its port
related:
  - ../quickstart.md
  - ../reference/commands.md
  - ../troubleshooting.md
source_anchors:
  - path: src/usage.js
    fingerprint: sha256:4a1b564592bd5b27
  - path: src/capture.js
    fingerprint: sha256:a22d68807c0f8276
---

# Show the app on a phone, and let the AI look at it

## Prerequisites

- [Quickstart](../quickstart.md) done, `mp doctor` reports `ok` four times
- Your app is running locally and you know its port

```mermaid
flowchart TD
  A[app listening locally] --> B{what is exposed}
  B -->|build output| C[mp start --port N]
  B -->|dev server| D[mp start --port N --dev]
  C --> E[send the link to the phone]
  D --> E
  E --> F{who looks}
  F -->|you| G[open in the phone browser]
  F -->|the AI| H[mp capture]
  G --> I[mp stop]
  H --> I
```

## Opening a preview

Start: a terminal in any directory, with your app listening on a local port.

1. Run `mp start --port <your port>`.
2. Add `--dev` when what you expose is a dev server (Vite, Webpack dev server) rather than a
   build.
3. Add `--ttl <minutes>` for a longer or shorter lifetime; the range is 1 to 1440.
4. Send the printed link to your phone and open it.
   - Expected: the command prints
     `preview: https://….trycloudflare.com/?__mp_token=…` and `expires in 30 min`, and the
     phone shows the same page as the desktop (evidence E009).

This is what it looks like on the phone:

![The demo app at phone size: heading "演示应用", subtitle "跑在本机 127.0.0.1:4173", four order rows, and a green button](../../assets/screenshots/phone-preview-demo.png)

## Letting the AI look at the page

Start: one preview is running and `mp status` lists it.

1. Run `mp capture`. With a single preview running you need no port.
2. Add `--network-idle` for API-driven single-page apps, so the shot waits for the network to
   settle.
3. Add `--full-page` for the whole scrollable page rather than the first screen.
4. Add `--video` to record instead of shoot; it needs ffmpeg on PATH.
   - Expected: one line of `![shot-N](https://…/_a/…/shot-N.png)`, followed by
     `Page loaded clean: no console errors, no failed requests.` or a list of what the page
     reported (evidence E009).

The output is Markdown image syntax, so pasting it to an AI is enough for it to see the shot.
Console errors and failed requests come back in the same report, which is the whole point of
handing diagnosis to the AI.

## Running several previews at once

One port takes one slot, so a front end and an admin panel can each have their own. With a
single preview running, `mp capture` and `mp stop` default to it; past one, they refuse to
guess:

```text
$ mp capture
several previews are active (ports 4173, 4180). Pass --port to pick one.
```

Pass `--port` explicitly at that point (evidence E009).

## Two known limits with dev servers

The tunnel does not forward WebSocket upgrades, so Vite hot reload does not work through a
preview. Edit your code, then refresh the phone by hand.

For the same reason a page relying on SSE looks broken through a preview: events pile up until
the connection closes.

## Verify

Run `mp status`: a working preview shows its slot, link and remaining time; after `mp stop`
the slot is gone from the list and the phone no longer loads the page.

## If it fails

When the link never appears or the attempt fails, read the failure class the command prints,
then `%LOCALAPPDATA%\mobile-preview\previews\<port>.cloudflared.log`.

A 530 on the phone means the tunnel dropped after coming up; run `mp start` again, as mp does
not reconnect on its own. A 404 means the link lost its token or expired; take the current one
from `mp status`.

More symptoms in [Troubleshooting](../troubleshooting.md).
