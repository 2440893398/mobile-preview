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

## Design

See `docs/superpowers/specs/2026-08-05-mobile-preview-design.md`.

## Security

- Everything behind the tunnel requires a 32-byte token
- All auth failures return 404, never 403
- `/@fs/`, `.env`, `.git/` are blocked in every mode
- The session cookie is stripped before requests reach your app
- The daemon self-terminates at TTL, so an orphaned tunnel still dies
