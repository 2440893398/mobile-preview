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

## Use

```bash
npm run build && npm run preview
mp start --port 4173
mp capture
mp capture --video
mp stop
```

Several previews can run at once, one per target port. `capture` and `stop`
default to the only active preview and refuse to guess when more than one is
running — pass `--port` then. `mp status` lists every slot.

| Flag | Default | Meaning |
|---|---|---|
| `--port` | 5173 | The local port to expose |
| `--ttl` | 30 | Minutes before the preview self-terminates |
| `--grace` | 10 | Minutes the `?t=` link stays exchangeable after its first use |
| `--dev` | off | Expose a dev server rather than a build (larger attack surface) |

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
  fails, read `%LOCALAPPDATA%\mobile-preview\previews\<port>.cloudflared.log`
  — every attempt is in there, separated by `--- attempt N/M ---`.
- A tunnel that comes up can still drop later. It shows as HTTP 530 or a
  truncated transfer. There is no reconnect: run `mp start` again.
- Keep recordings short and phone-sized. At 50 KB/s a 1 MB video is 20 seconds
  of staring at a spinner.

Quick Tunnel also does not support SSE (events pile up until the connection
closes) and caps concurrent in-flight requests at 200, returning 429 beyond
that. An app that depends on SSE will look broken through the preview.

## Design

See `docs/superpowers/specs/2026-08-05-mobile-preview-design.md`.

## Security

- Everything behind the tunnel requires a 32-byte token
- All auth failures return 404, never 403
- `/@fs/`, `.env`, `.git/` are blocked in every mode
- The session cookie is stripped before requests reach your app
- The daemon self-terminates at TTL, so an orphaned tunnel still dies
