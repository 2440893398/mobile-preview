# mobile-preview

**Your coding agent runs on your laptop. You are holding a phone.** `mp` is the wire
between the two.

When Claude Code or Codex is driven from a phone — through
[Happy](https://github.com/slopus/happy), over SSH, from anywhere that is not this desk —
it keeps answering with `http://localhost:5173`. On a phone that address *is* the phone,
so the link is a dead end. Screenshots, passwords and "which of these three do you want"
hit the same wall.

```text
without mp   agent ──▶ "open http://localhost:5173"   ──▶ phone: dead end
with mp      agent ──▶ mp start --port 5173           ──▶ phone: https://<name>.trycloudflare.com/?__mp_token=...
```

Four things it hands the agent, every one of them token-gated and short-lived:

| command | what arrives on the phone |
|---|---|
| `mp start --port 5173` | a temporary https link to the local app — `--dev` for a Vite/Webpack server |
| `mp start --serve ./page.html` | the same link for a page mp serves itself — no server of your own to start, or to forget |
| `mp capture --port 5173` | a phone-sized screenshot **the agent itself** reads, with failed requests and console errors |
| `mp secret ask` | a form for a password or API key, so it never lands in the chat transcript |
| `mp interaction ask` | a real page for a decision, instead of a wall of options in a chat bubble |

It also ships a Claude Code / Codex plugin, so the agent reaches for all of this on its
own — the person on the phone types "看看效果" or "send me the link", not the name of a tool.

## Install

```bash
npm i -g mobile-preview-cli
npx playwright install chromium
winget install --id Cloudflare.cloudflared   # macOS: brew install cloudflared
mp doctor
```

`mp doctor` checks all four prerequisites separately and prints the command that fixes
whatever is missing. In Windows PowerShell the command is `mp.cmd` — there, `mp` is the
built-in alias for `Move-ItemProperty`. From a clone instead: `npm install && npm link`.

The npm package is **`mobile-preview-cli`**; the command it installs is `mp`.

## Use it as a plugin

The CLI is the tool; the plugin is what makes the agent reach for it without being asked — a
skill whose description carries the words people actually type, and hooks that notice a phone
session. Install the CLI first, then:

```bash
claude plugin marketplace add https://github.com/2440893398/mobile-preview
claude plugin install mobile-preview@mobile-preview
```

Inside an interactive session the same two steps are `/plugin marketplace add ...` and
`/plugin install ...`. Codex reads the same directory — `plugins/mobile-preview` carries a
`.claude-plugin/` and a `.codex-plugin/` manifest — and needs its hooks trusted once, in a
local `codex` session, before they run.

## Manual

Everything about using mp lives in the manual — installation, the first preview, screenshots,
secrets, decision pages, every flag, and troubleshooting:

- **[Operating manual (English)](https://2440893398.github.io/mobile-preview/en/)**
- **[操作手册（中文）](https://2440893398.github.io/mobile-preview/)**

Same pages in the repository, if you prefer reading them here:
[English](docs/guide/en/index.md) · [中文](docs/guide/index.md)

The rest of this file keeps only what the manual does not cover: the measured behaviour on
mainland-China networks, why the skill triggers the way it does, and the security model.

New links use `?__mp_token=<token>`. The old `?t=<token>` form is still accepted so links
already sent to a phone keep working, but it is no longer issued: Vite uses `?t=<timestamp>`
for module cache-busting, and sharing that name is what made dev-mode previews render blank.

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

The second is a `SessionStart` hook (`plugins/mobile-preview/hooks/`). When the
session was started through Happy it tells the model,
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
  the current plugin hook definitions in a local `codex` session.
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
question at the precise moment the model asks it. It measures shape, never
subject: three or more
options each carrying a sentence of explanation, or two substantial questions
at once, or one long one. A hook cannot tell whether a decision is important,
and one that guessed would be wrong in both directions.

Every threshold in both hooks weighs CJK characters at three (`hooks/cjk.mjs`),
because the same sentence runs about 26 characters in Chinese and 123 in
English, and a single character count would have meant this never fired for a
Chinese-speaking user. It is shared rather than written twice because it *was*
written twice: 0.5.0 weighed the question tool's thresholds and left Stop
counting raw characters, so the one trigger that works on Codex needed a
message three times too long before it fired — on the machine where the
questions are written in Chinese.

A **Stop** hook is the fallback, and on Codex the main line of defence: that
host's own instructions tell it to write a question it must have answered as
plain prose rather than call a tool, so the PreToolUse path never sees it. Stop
reads the finished message instead — long, ending in a question or a list, with
no interaction page *waiting for an answer* — and asks for the page. A record
that has already been answered does not count: it outlives the answer by its
whole TTL, and counting it would silence this hook for the rest of the
afternoon. Those tokens are already spent, which is why it is third; it gives
up after twice in a session rather than arguing with a model that has a reason
to write that way. When the session mode is unknown, either decision hook first
asks the user one short question. An exact `远端` or `本机` reply is saved by a
`UserPromptSubmit` hook; `mp remote on/off` also saves the choice. Only a
confirmed remote choice causes large decisions to move to `mp interaction`.

For preview links the rule is simpler: a localhost page is never the only link
handed to the user. Stop requests an `mp start` link regardless of the device,
while allowing an additional local link. Preview checks do not consume the
two-attempt budget for long decisions. Happy detection and the manual choice
share `%LOCALAPPDATA%\mobile-preview\sessions\<id>.json`.

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
  daemon's memory, never printed, and reachable through a protocol that has no
  read operation; every use is audited
- A value reaches the disk only if the user ticks "remember" on the phone, and
  then only as AES-GCM ciphertext under a key the system keystore holds
  (DPAPI, Keychain, Secret Service) — no keystore, no saving. This keeps the
  value from anything that merely reads files; it does not keep it from an AI
  running as the same user that sets out to call the keystore. The passphrase
  level adds a factor that AI has to guess offline first — a delay whose length
  is the passphrase's, not a wall
- A config file rendered with a real value must be git-ignored, is deleted when
  its command or slot ends, and is kept from the AI's file tools by the hook
- An `mp interaction` page is served under `default-src 'none'` and refused
  before it is ever linked if it would fetch anything; its audit log records
  which fields were answered, never what they say
