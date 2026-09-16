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

A preview runs in the background with no window of its own: nothing appears on
the desktop, and there is nothing to close by hand. `mp status` is where it is
visible instead — link, remaining TTL, both pids, and the cloudflared log for
that port. Three things bound a preview's life: its `--ttl`, `mp stop`, and the
orphan sweep `mp status` and `mp stop` run before they report, which reclaims
any cloudflared whose daemon was killed outright and left it with nothing to
expire it.

### `mp start`

| Flag | Default | Meaning |
|---|---|---|
| `--port` | 5173 | The local port to expose |
| `--ttl` | 30 | Minutes before the preview self-terminates (1–1440) |
| `--grace` | same as `--ttl` | Minutes the link stays exchangeable after its first use, so by default it works for the preview's whole life (0 = one-shot) |
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

### `mp secret`

Credentials the phone fills in and the AI may use but never read. When a task
needs an access key, a password or a token, the model must not ask for it in
the chat: the value would land in the transcript, in the model's context and in
every later turn. Instead:

```bash
mp secret ask --purpose "Configure OSS uploads" --field OSS_ACCESS_KEY_ID --field OSS_ACCESS_KEY_SECRET --field OSS_BUCKET:text --use "npm run deploy" --use "node scripts/check-oss.js"
mp secret wait --id s-7f3a1c
mp secret run --id s-7f3a1c -- npm run deploy
mp secret forget --id s-7f3a1c
```

`ask` starts a daemon that serves a one-page form on a fresh tunnel and prints
the link; the model hands it over as a bare line, like a preview link. On the
phone the user types the values — masked inputs; a `text` field is shown and
not redacted, a `multiline` field is a textarea for PEM keys — and ticks the
commands the model declared it wants to run. The page encrypts every field in
the browser (ECDH P-256 + HKDF + AES-GCM, the field name as associated data)
before posting, so the tunnel's edge, which terminates TLS, sees ciphertext
only. On submission the tunnel is torn down and the values live in the
daemon's memory until `--ttl` (default 120 min) or `mp secret forget`.

`wait` blocks until that happens and reports names, lengths and an 8-hex
SHA-256 prefix per field — enough to spot a mispaste, never the value.

`run` sends the argv to the daemon over a named pipe (a unix socket elsewhere).
The daemon runs it only if it is, word for word, one of the uses the user
ticked; injects the values as environment variables; and streams stdout and
stderr back with every secret value — and its base64, base64url, URL-encoded
and JSON-escaped forms — replaced by `[REDACTED:NAME]`. The exit code is passed
through. A command the user did not tick is refused;
`mp secret ask --id <id> --use "<command>"` sends the phone a link to approve
it, without re-entering the values. Nothing is written to disk: a project's
`.env` can leave the key empty, since `dotenv` and its relatives do not
override a variable that is already in the environment.

The IPC protocol has no operation that returns a value. That, not policy, is
what keeps the values out of the model's reach: nothing the CLI can be asked
for contains one. The plugin adds a PreToolUse hook that refuses the crudest
ways of turning a run into an environment dump (`sh -c`, `cmd /c set`,
`printenv`, `$env:`…); it is heuristic and the third line of defence, not the
first — but it is the one control that still holds in `bypassPermissions`
mode, where `settings.json` deny rules do not apply.

What this does not do: stop a process the model controls from leaking a value
it was legitimately given. `npm run deploy` with a `deploy` script the model
just edited can write the secret anywhere. `op run` and GitHub Actions secrets
have the same boundary. Give the model scoped, revocable credentials — a RAM
sub-account for one bucket, an STS token, a database user for one schema — and
keep the TTL short. The design, the facts it rests on and the full threat model
are in `docs/superpowers/specs/2026-09-11-secret-relay-design.md`.

| Flag of `mp secret ask` | Default | Meaning |
|---|---|---|
| `--purpose` | – | One line shown at the top of the form: what the values are for |
| `--field` | – | `NAME[:secret\|text\|multiline]`, repeatable |
| `--use` | – | A command to get approved on the phone, repeatable |
| `--id` | – | Ask an existing slot to approve more `--use` commands instead of opening a new one |
| `--ttl` | 120 | Minutes the values stay in memory once they arrive (1–1440) |
| `--form-ttl` | 30 | Minutes the form link stays open (1–60) |
| `--json` | off | Print a machine-readable object instead of prose |

`mp secret status` lists slots — fields, fingerprints, approved uses, time
left, runs, the audit log — and `mp secret forget [--id <id> | --all]` wipes
them early. Every fill, run, denial and expiry is appended to
`%LOCALAPPDATA%\mobile-preview\secrets\<id>.log`; the state file next to it
holds names and fingerprints only.

### `mp interaction`

A decision the user makes on a page, whose answer comes back as JSON. The
mirror image of `mp secret`: that one is careful never to print what it
collects, this one exists to print exactly that.

It is for the question that does not fit in a chat — three or more options to
compare, several values to set, an order to put things in, a draft to review.
Written out in a message, that is a wall of text the user has to read on a
phone, hold in their head, and answer by typing; what comes back is prose the
model then has to interpret. A yes/no still belongs in the chat.

```bash
mp interaction ask --purpose "Which four things come first this week" --html ./decide.html
mp interaction wait --id i-7f3a1c
```

The page is written by the model, not by this tool — there is no component
library here and no house style. What there is, is a contract, checked before
the link is ever issued so a bad page fails where the reasons can be read
rather than on the phone where they cannot: one self-contained file under
300 KB, **no external resources at all** — no CDN script, stylesheet, web font
or image, which rules out React and Babel — no `<form action>`, no
`<script type="module">`, at least one `data-mp-submit`, and something that
carries an answer.

What the tool injects is the part every page would otherwise reimplement and
some would get subtly wrong: draft saving to the phone *and* back to this
machine, restoring it on reload, `required` enforcement, a submission that is
idempotent on its own id, and a receipt. A page gives controls a `name`, or
calls `MP.set(name, value)` for something like a sortable list; a second submit
button carrying `data-mp-disposition="needs_clarification"` lets the user say
the question itself is wrong, which is why this is more than a form.

`wait` blocks for `--timeout` seconds — 540 by default, sized for a tool call
that may not block for more than ten minutes — and **exits 0 in every normal
case**. Read `status`, not the exit code: `submitted` carries the answers,
`waiting` means they are still reading and carries the partial draft, and
`expired_link` means the link lapsed with the draft intact. A timeout is not a
failure; someone thinking carefully about a decision routinely takes longer
than any single call may wait, and exiting non-zero there would end the turn
instead of letting the model wait again. Reading the same answer twice returns
the same thing, so a compaction that lost it is recoverable.

`ask --id <id>` replaces an open question's page and bumps its revision, so a
tab still showing the previous one is refused with a 409 rather than answering
the new question with the old one's options. The answer lives in the state file
rather than in memory — it has to outlive the process that collected it — until
its `--ttl` or `mp interaction close`.

| Flag of `mp interaction ask` | Default | Meaning |
|---|---|---|
| `--html` | – | The page to serve; checked before a link is issued |
| `--purpose` | – | One line for `mp interaction status` |
| `--id` | – | Replace an open question's page, bumping its revision |
| `--ttl` | 120 | Minutes the answer stays readable after it arrives (1–1440) |
| `--form-ttl` | 30 | Minutes the link stays open (1–60) |
| `--json` | off | Print a machine-readable object instead of prose |

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

### Three triggers for a decision, not one

The same problem in a harder form: a model that has decided it needs the user
does not know that writing the question out is the expensive way to ask it. So
the plugin catches that at three points, deliberately redundant, because each
one misses something the next one covers.

The **SessionStart** context above carries the rule: a choice among three or
more options, several values, an ordering, or a review of more than a screen
goes on a page. That is the cheap one — one paragraph, once per session — and
the only one that acts *before* the tokens are spent.

A **PreToolUse** hook on `AskUserQuestion` / `request_user_input` catches the
question at the precise moment the model asks it, and denies it with the
instruction to use a page. It measures shape, never subject: three or more
options each carrying a sentence of explanation, or two substantial questions
at once, or one long one. A hook cannot tell whether a decision is important,
and one that guessed would be wrong in both directions. The thresholds weight
CJK characters at three, because the same sentence runs about 26 characters in
Chinese and 123 in English, and a single character count would have meant this
never fired for a Chinese-speaking user.

A **Stop** hook is the fallback, and on Codex the main line of defence: that
host's own instructions tell it to write a question it must have answered as
plain prose rather than call a tool, so the PreToolUse path never sees it. Stop
reads the finished message instead — long, ending in a question or a list, with
no interaction page open — and asks for the page. Those tokens are already
spent, which is why it is third; it gives up after twice in a session rather
than arguing with a model that has a reason to write that way.

All three stay silent in a local session, where the host's own prompt in the
terminal is already a good answer. Working that out costs a process-tree walk
on the host whose environment cannot say, so SessionStart does it once and
writes the verdict to `%LOCALAPPDATA%\mobile-preview\sessions\<id>.json`; the
other two read it. No note means "not a phone session, or we never found out",
and both of those mean stay quiet.

Plugin caches key on the version, so a `hooks/` or skill change only reaches the
host after the version in the four manifests is bumped.

## Design

See `docs/superpowers/specs/2026-08-05-mobile-preview-design.md`.

## Security

- Everything behind the tunnel requires a 32-byte token
- All auth failures return 404, never 403
- `/@fs/`, `.env`, `.git/` are blocked in every mode
- The session cookie is stripped before requests reach your app
- The daemon self-terminates at TTL, and `mp status`/`mp stop` reap any tunnel
  whose daemon died before it could, so no tunnel outlives what tracks it
- Values collected by `mp secret` are encrypted in the browser, held in one
  daemon's memory only, never written to disk or printed, and reachable
  through a protocol that has no read operation; every use is audited
- An `mp interaction` page is served under `default-src 'none'` and refused
  before it is ever linked if it would fetch anything; its audit log records
  which fields were answered, never what they say
