# mobile-preview

Temporary, authenticated preview of a locally running app for phone-based AI workflows.

## Install

```bash
npm install
npx playwright install chromium
winget install --id Cloudflare.cloudflared
npm link
```

Install `ffmpeg` and make sure it is on `PATH` if you want `mp capture --video`
to produce phone-playable MP4 recordings.

In Windows PowerShell call `mp.cmd`: `mp` there is the built-in alias for
`Move-ItemProperty`. Every other shell can use `mp`.

Run `mp doctor` to check the whole setup at once. It tells apart "the CLI is not
installed", "it is linked but this shell cannot see it", "cloudflared is
missing", "no browser for `mp capture`", and "no ffmpeg, so only `--video` is
affected" — and prints the command that fixes each one.

## Use

```bash
npm run build && npm run preview
mp start --port 4173
mp capture
mp capture --video
mp stop
```

`mp --help` lists the commands, `mp <command> --help` the options of one, and
`mp --version` the version. Unknown options are refused by name rather than
swallowed.

Several previews can run at once, one per target port. `capture` and `stop`
default to the only active preview and refuse to guess when more than one is
running — pass `--port` then. `mp status` lists every slot.

### `mp start`

| Flag | Default | Meaning |
|---|---|---|
| `--port` | 5173 | The local port to expose |
| `--ttl` | 30 | Minutes before the preview self-terminates (1–1440) |
| `--grace` | 10 | Minutes the link stays exchangeable after its first use (0 = one-shot) |
| `--dev` | off | Expose a dev server rather than a build (larger attack surface) |
| `--json` | off | Print `{status, url, port, expiresAt, …}` on stdout instead of prose |

`start` reports the stage it is waiting on — asking trycloudflare.com for a
tunnel, then waiting for an edge connection — and only ever prints a link once
cloudflared has actually registered with the edge. A url without a registered
edge connection is the failure that shows up as HTTP 530 on the phone, so it is
never reported as success. If a daemon for that port is already starting, a
second `mp start` attaches to it rather than racing a second one into the same
slot. When the wait runs out, the message names the last stage reached, whether
the daemon is still trying, and the cloudflared log to read.

### `mp capture`

| Flag | Default | Meaning |
|---|---|---|
| `--port` | the only active preview | Which preview to capture through |
| `--device` | iPhone 13 | Playwright device profile, e.g. `"Pixel 7"` |
| `--steps` | – | ESM file default-exporting `async (page) => {}` |
| `--video` | off | Record an MP4 (needs ffmpeg on `PATH`) |
| `--wait-for` | – | Wait until a CSS selector is visible before shooting |
| `--wait-ms` | 500 | Extra milliseconds to wait after the page settles |
| `--network-idle` | off | Wait for the network to fall idle — for API-driven SPAs |
| `--full-page` | off | Capture the whole scrollable page |
| `--strict` | off | Exit non-zero when the page had errors |

Failed requests are reported with their full URL, status code and resource
type. Browser console lines of the form "Failed to load resource: … 404" carry
the URL on the message's *location* rather than in its text, so they are folded
back onto the matching request — and when no request record exists, one is
reconstructed from the console entry. Favicons, source maps and `robots.txt`
are listed separately as ignorable rather than mixed in with a missing entry
script.

### Query parameters

New links use `?__mp_token=<token>`. The old `?t=<token>` form is still accepted
so links already sent to a phone keep working, but it is no longer issued: Vite
uses `?t=<timestamp>` for module cache-busting, and sharing that name is what
made dev-mode previews render blank. In dev mode a request carrying a valid
`mp_session` cookie is forwarded with its `?t=` query intact.

## Running from mainland China

Measured 2026-08-06 on a residential connection with a local proxy available:

| | |
|---|---|
| `api.trycloudflare.com` reachable | ~1 attempt in 3, direct and through a proxy alike |
| Tunnel establishment | once on the first try, once only on the eighth |
| Throughput once up | ~50 KB/s |
| Data plane | a 527 KB download was truncated at 128 KB, then 530s |

What follows from that:

- cloudflared is forced onto `--protocol http2`. Its default QUIC/UDP 7844 is
  heavily disrupted here and the tunnel reconnects in a loop.
- `mp start` retries establishment four times before giving up. When it still
  fails, the message says which of the three failures it was — the local port
  was unreachable, `api.trycloudflare.com` could not be reached at all, or a
  url was issued but no edge connection ever registered — and names
  `%LOCALAPPDATA%\mobile-preview\previews\<port>.cloudflared.log`, where every
  attempt is kept, separated by `--- attempt N/M ---`.
- A tunnel that comes up can still drop later. It shows as HTTP 530 or a
  truncated transfer. There is no reconnect: run `mp start` again.
- Keep recordings short and phone-sized. At 50 KB/s a 1 MB video is 20 seconds
  of staring at a spinner.

Quick Tunnel also does not support SSE (events pile up until the connection
closes) and caps concurrent in-flight requests at 200, returning 429 beyond
that. An app that depends on SSE will look broken through the preview.

The proxy does not forward WebSocket upgrades at all, so anything built on
them — Vite HMR first of all — does not work through the preview. A `--dev`
preview still serves the app; reload the page on the phone to pick up changes.

## Remote sessions trigger the skill on their own

A skill only fires when the model thinks of it, and it thinks of it from the
words the user typed. Someone holding a phone types "show me how it looks now",
not "use the mobile-preview plugin" — and gets back a `http://localhost:5173`
that on their device points at the phone itself.

Two things answer that, and the cheaper one is the skill's own `description`.
Both hosts put only a skill's name and description into the listing the model
picks from, so that text is where triggering is won or lost: it names the
concrete words a user says — "on my phone", "看看效果", "screenshot", "预览",
"localhost 打不开" — instead of describing the tool. That works in every session,
local or remote, with nothing installed.

The second is a `SessionStart` hook (`plugins/mobile-preview/hooks/`), for the
case where the user does not ask at all and a local URL is about to be handed
over anyway. When the session was started through Happy it tells the model,
once, at the top of the conversation: this person is not at this machine, a
local address is not a deliverable, expose it with `mp start` and return the
preview link instead. In a local session the hook prints nothing. One file
serves both hosts — Claude
Code and Codex each discover `<plugin>/hooks/hooks.json`, substitute
`${CLAUDE_PLUGIN_ROOT}`, and read back the same
`hookSpecificOutput.additionalContext`.

Detection reads the environment rather than the phrasing: `CLAUDE_CODE_EXECPATH`
pointing inside Happy's npm package, any `HAPPY_*` variable, or
`CLAUDE_CODE_ENTRYPOINT=remote_mobile`. It deliberately does not search the
environment for the string "happy" — a machine with Happy installed has it in
`NO_PROXY` and `PATH`, which would report every local terminal session as remote.

A Codex session leaves none of those traces: Happy drives it as
`codex app-server` with a plain inherited environment, and the one place the
name lands — `originator: happy-codex` in the rollout file — is written 8–25
seconds in, against 0.2s for a local session, far too late for a hook. So when
the environment cannot answer and the host is not Claude Code, the hook reads
the process tree instead, where the happy CLI is always an ancestor. That costs
about 0.8s on Windows and runs only on that path.

Two things to know about Codex specifically:

- **Hooks do not run until they are trusted.** Codex reviews new and modified
  hooks at startup in the TUI ("Hooks need review… Trust all and continue"), and
  silently skips them otherwise — which looks exactly like a broken hook. Trust
  it once in a local `codex` session and Happy-driven sessions inherit it.
  `codex exec --dangerously-bypass-hook-trust` skips the gate for automation.
- The process-tree walk stops at the first ancestor that has already exited.
  Normal spawn chains stay intact; a shell that emulates `exec` by respawning
  itself can sever it, and the session is then read as local.

Plugin caches key on the version, so a `hooks/` or skill change only reaches the
host after the version in the four manifests is bumped.

## Design

See `docs/superpowers/specs/2026-08-05-mobile-preview-design.md`.

## Security

- Everything behind the tunnel requires a 32-byte token
- All auth failures return 404, never 403
- `/@fs/`, `.env`, `.git/` are blocked in every mode
- The session cookie is stripped before requests reach your app
- The daemon self-terminates at TTL, so an orphaned tunnel still dies
