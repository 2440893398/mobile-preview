---
title: Command reference
description: Look up every mp flag, its default and its range, plus where to install the plugin
doc_type: reference
module: Reference
audience: Users past the first run who need a flag
updated_at: 2026-09-20
source_evidence: [E002, E012]
source_anchors:
  - path: src/usage.js
    fingerprint: sha256:4a1b564592bd5b27
---

# Command reference

This page is transcribed from `mp --help` and each subcommand's `--help` (evidence E012);
defaults come from `src/usage.js` (evidence E002). In Windows PowerShell write every `mp`
as `mp.cmd`.

Global: `-h, --help` shows help, `mp <command> --help` shows one command's options, and
`-v, --version` prints the version. Unknown options are refused by name rather than swallowed.

## All commands

| Command | What it does | Flags you reach for |
|---|---|---|
| `mp start` | Expose a local port as a temporary authenticated public link | `--port` `--serve` `--ttl` `--dev` |
| `mp capture` | Screenshot at phone size and report what went wrong on the page | `--port` `--full-page` `--network-idle` |
| `mp status` | List active previews and how long each has left | `--json` |
| `mp stop` | Tear a preview down and leave nothing running | `--port` `--all` |
| `mp doctor` | Check everything mp needs is installed, on PATH and reachable | none |
| `mp secret ask/wait/run/render/peek/saved/status/forget` | The phone fills in credentials the AI may use but never read; they can be saved encrypted on this computer | `--field` `--use` `--render` `--id` |
| `mp interaction ask/wait/status/close` | Put a decision on a page, get the answer as JSON | `--html` `--id` `--timeout` |

## mp start

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | 5173 | Local port to expose — the one your app already listens on; refused together with `--serve` |
| `--serve <path>` | none | Serve this file or directory from mp itself instead of proxying a server you started. mp picks a free port and hosts it inside the preview daemon, so it goes away with the preview. A directory is served whole; a single file is served alone, so its siblings stay off the url
| `--ttl <min>` | 30 | Minutes before the preview self-terminates, 1 to 1440 |
| `--grace <min>` | same as `--ttl` | Minutes the link stays exchangeable after first use; `0` makes it one-shot |
| `--dev` | off | Expose a dev server rather than a build, a larger attack surface |
| `--json` | off | Print one machine-readable JSON object instead of prose |

## mp capture

Usage is `mp capture [url] [options]`; without a url it shoots the preview root.

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | the only active one | Which preview to capture through |
| `--device <name>` | iPhone 13 | Playwright device profile, e.g. `"Pixel 7"`, `"iPhone 15 Pro"` |
| `--steps <file>` | none | ESM file default-exporting `async (page) => {}`, run before the shot |
| `--video` | off | Record the session as MP4; needs ffmpeg on PATH |
| `--wait-for <selector>` | none | Wait until this CSS selector is visible |
| `--wait-ms <n>` | 500 | Extra milliseconds after the page settles |
| `--network-idle` | off | Wait for the network to fall idle, not just for load |
| `--full-page` | off | Capture the whole scrollable page, not just the first screen |
| `--strict` | off | Exit non-zero when the page had console errors or failed requests |

`--json` on `mp status` and `--port` / `--all` on `mp stop` mean the same as above; `--all`
also stops stale and unreadable slots.

## mp secret

By default values exist only in each daemon's memory. Tick "remember" on the phone and they are
saved encrypted on this computer, then used at the level you picked (auto / one tap / passphrase).
`status`, `wait` and `saved` report names and fingerprints, never values.

| Subcommand | Key flags | Default | Meaning |
|---|---|---|---|
| `secret ask` | `--purpose <text>` | none | One line atop the form: what these values are for |
| | `--field <NAME[:kind]>` | kind `secret` | A field to collect, repeatable. `secret` is masked and redacted from output, `text` is visible and not redacted, `multiline` is a textarea |
| | `--use <command>` | none | A command the AI intends to run with the values, repeatable; you tick each on the phone |
| | `--render <TPL=OUT>` | none | For a tool that only reads its key from a config file: write it from a template (placeholders are `mp:NAME` in double curly braces), repeatable; you tick each on the phone, and the file is deleted when the command exits |
| | `--render-keep <TPL=OUT>` | none | Like `--render`, but the file stays until `mp secret forget --files` |
| | `--refill` | off | Ask for the values afresh even if they are saved for this project |
| | `--id <id>` | none | Ask an existing slot to approve more uses or render targets without re-entering values |
| | `--ttl <min>` | 120 | Minutes the values stay in memory once they arrive, 1 to 1440 |
| | `--form-ttl <min>` | 30 | Minutes the form link stays open, 1 to 60 |
| `secret wait` | `--timeout <sec>` | 540 | Seconds before giving up; the link stays open regardless |
| `secret run` | `--cwd <dir>` | current directory | Working directory. Usage is `mp secret run [options] -- <command…>` |
| | `--render <TPL=OUT>` | none | Write this approved config file before the command starts; delete it when the command exits |
| `secret render` | `<TPL=OUT…>` | none | Write approved config files; deleted when the slot ends unless approved to keep |
| `secret peek` | `<file>` | none | Show a file mp wrote, with every value redacted |
| `secret saved` | `--all` | off | List the fields, levels, dates and remembered uses saved for this project — never values; `--all` lists every project |
| `secret forget` | `--all` | off | Forget every slot, including stale ones |
| | `--saved [NAME…]` | off | Delete the values saved for this project instead: all, or only the NAMEs given |
| | `--files` | off | Delete the rendered files this project kept instead |

## mp interaction

| Subcommand | Key flags | Default | Meaning |
|---|---|---|---|
| `interaction ask` | `--html <file>` | none | The page to serve: one self-contained HTML file with no external resources, checked before the link is issued |
| | `--purpose <text>` | none | One line for `mp interaction status` |
| | `--id <id>` | none | Replace an open question's page, bumping its revision |
| | `--ttl <min>` | 120 | Minutes the answer stays readable, 1 to 1440 |
| | `--form-ttl <min>` | 30 | Minutes the link stays open, 1 to 60 |
| `interaction wait` | `--timeout <sec>` | 540 | On timeout it reports "still waiting" and exits 0; the link stays open |
| `interaction close` | `--all` | off | Close every question, including stale ones |

## Installing the plugin

To make the AI reach for these commands on its own, install steps and the three hooks are in
the [plugin readme](https://github.com/2440893398/mobile-preview/blob/main/plugins/mobile-preview/README.md).
Once installed, phrases like "show me on my phone", "screenshot it" or "send me the link" in a
remote session trigger it.

> That is a repository URL rather than a relative path on purpose: this page is mirrored into
> `docs/guide/`, at a different directory depth, so a relative path leaving the manual would
> break after mirroring.
