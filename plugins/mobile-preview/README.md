# Mobile Preview Codex Plugin

This plugin teaches Codex when and how to use the `mp` CLI across projects.
It does not replace the CLI or install Cloudflare, Playwright, or ffmpeg for
you. Install the `mobile-preview` tool once, run `npm link`, and then the
plugin can use `mp` from any project.

Typical use:

```powershell
mp.cmd start --port 8080 --dev
mp.cmd capture --port 8080
mp.cmd stop --port 8080
```

PowerShell reserves `mp` as an alias for `Move-ItemProperty`; use `mp.cmd` in
PowerShell. Other shells can use `mp` directly.

Run `mp.cmd doctor` first when anything looks wrong — it reports each
prerequisite separately, with the command that fixes it. `mp.cmd --help` lists
the commands and `mp.cmd <command> --help` the options of one.

For Vite/Webpack dev servers, use `--dev`. Preview links are issued as
`?__mp_token=<token>`; the older `?t=<token>` form is still accepted so links
already sent keep working, but is no longer issued, because Vite uses
`?t=<timestamp>` for module cache-busting. After the initial session exchange
those module URLs are forwarded normally instead of being mistaken for tokens.

`mp capture` reports failed resource URLs with their HTTP status and resource
type — including the ones the browser only mentions on the console — which
makes a blank page caused by a missing script easier to diagnose. Favicons and
source maps are listed as ignorable rather than mixed in. `--wait-for`,
`--network-idle` and `--full-page` cover SPAs that are not finished rendering
half a second after load.

The repository-local marketplace entry is in `.agents/plugins/marketplace.json`.
