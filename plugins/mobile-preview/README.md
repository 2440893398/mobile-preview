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

When a task needs a credential from the user — an access key, a password, a
token — it is never asked for in the chat. `mp.cmd secret ask` sends the phone
a form, `mp.cmd secret wait` reports that it was filled in (names and
fingerprints only), and `mp.cmd secret run -- <command>` runs one of the
commands the user ticked with the values in its environment and the output
redacted. No command prints a value; the plugin's PreToolUse hook refuses the
obvious ways of dumping the environment through a run.

When a decision belongs to the user — three or more options to compare, several
values to set, an order to settle, a draft to review — it is not written out in
the chat either. `mp.cmd interaction ask --html <file>` checks a self-contained
HTML page, serves it on a tunnel and prints a link; `mp.cmd interaction wait`
blocks until the phone submits and prints the answers as JSON. A timeout there
is not an error: it exits 0 with `status: "waiting"` and whatever is filled in
so far, because someone thinking about a decision takes longer than a single
call may block.

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

## Remote sessions

The plugin also installs a `SessionStart` hook (`hooks/hooks.json` →
`hooks/session-start.mjs`), which Claude Code and Codex both pick up. In a
session started through Happy — where the user is on a phone and `localhost`
resolves to the phone itself — it states up front that a local address cannot be
handed over and that the app has to be exposed through `mp` first. Local
sessions get nothing.

Under Claude Code the check is a few environment variables. Under Codex nothing
in the environment says "happy", so the hook reads the process tree, where the
happy CLI is an ancestor of the session; that path costs about 0.8s and is only
taken when the environment could not answer.

Two more hooks push a decision onto a page rather than into the chat: a
`PreToolUse` on `AskUserQuestion` / `request_user_input`, which refuses a
question carrying three explained options or two substantial ones, and a `Stop`
hook that catches a long message ending in a question when no page is open. On
Codex the second matters more than the first — that host's own instructions
steer a must-answer question into prose instead of a tool call. Both stay
silent in a local session, reading the verdict SessionStart already wrote to
`sessions/<id>.json` rather than working it out again on every turn.

**Codex will not run the hook until you trust it.** New and modified hooks are
reviewed at startup in the Codex TUI; until then they are skipped silently.
Trust it once locally and Happy-driven Codex sessions inherit that trust.

The repository-local marketplace entry is in `.agents/plugins/marketplace.json`.
