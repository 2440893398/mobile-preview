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

## Design

See `docs/superpowers/specs/2026-08-05-mobile-preview-design.md`.

## Security

- Everything behind the tunnel requires a 32-byte token
- All auth failures return 404, never 403
- `/@fs/`, `.env`, `.git/` are blocked in every mode
- The session cookie is stripped before requests reach your app
- The daemon self-terminates at TTL, so an orphaned tunnel still dies
