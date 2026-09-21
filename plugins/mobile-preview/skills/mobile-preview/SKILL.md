---
name: mobile-preview
description: 'Use whenever a locally running app has to be opened, shown, verified or screenshotted by someone who is not at this machine — every time a localhost or 127.0.0.1 URL would otherwise be handed to the user, and in any remote session (Happy, phone) where such an address cannot be opened at all. Triggers on "on my phone", "手机上看看", "看看效果", "preview", "预览一下", "send me the link", "把链接发我", "screenshot", "截图", "mobile UI", "localhost 打不开", "这个地址打不开", "stop the preview", "关掉预览", and on mp start / mp capture / mp stop. Also use whenever such a session needs a credential from the user — a password, API key, AccessKey, token, database URL: "密码给你", "把 key 发你", "需要账号密码", "填一下配置", "credentials", "API key" — so it is collected with mp secret instead of typed into the chat. Also use whenever a decision belongs to the user and would otherwise be written out as a wall of text: three or more options to compare, several values to set, items to put in order, a draft to review — "你来定", "帮我选", "哪个好", "排个序", "看看这段改得对不对", "which one", "help me decide", "review this" — so it is asked with mp interaction as a page instead.'
---

# Mobile Preview

Use the installed `mp` CLI to give the user a temporary, token-gated URL for a
local web app. The plugin is project-agnostic: first identify the app's local
HTTP port, then use that port with `mp`.

## Remote sessions

A session started through Happy is a phone session: the person asking is not at
this machine, so `http://localhost:<port>` is not an answer they can act on — on
their device that address is the phone. In such a session this workflow is not
one option among several; it is the only way a local app can be handed over, and
it applies even when the user never names the plugin. The plugin's SessionStart
hook detects such a session and says so at the top of the conversation, on
Claude Code and Codex alike; under any other host, notice it yourself.

The signal is the environment, not the phrasing: `CLAUDE_CODE_EXECPATH` pointing
inside Happy's npm package, or a `HAPPY_*` variable, or
`CLAUDE_CODE_ENTRYPOINT=remote_mobile`. Do not test for the string "happy"
anywhere in the environment — a machine that has Happy installed carries it in
`NO_PROXY` and `PATH`, which makes every local session look remote. A Codex
session carries none of those, so there the hook reads the process tree, in
which the happy CLI is an ancestor.

If the notice never appears in a Codex session that clearly is remote, the
likely cause is hook trust: Codex reviews new and modified hooks at startup and
skips them until they are trusted, without saying so during the session.

## Prerequisites

The user must have completed the one-time setup in the mobile-preview tool
repository:

```powershell
npm install
npx playwright install chromium
winget install --id Cloudflare.cloudflared
npm link
```

Run `mp.cmd doctor` — or the plugin's `scripts/check-prerequisites.mjs` when the
CLI itself may be missing — before guessing at a setup problem. It reports each
prerequisite separately with the command that fixes it, and in particular tells
"the CLI was never linked" apart from "it is linked but this shell's PATH
predates the link", which look identical from the outside.

On Windows PowerShell, use `mp.cmd` instead of `mp`: PowerShell has an `mp`
alias for `Move-ItemProperty`. In Command Prompt, Git Bash, and other shells,
`mp` is fine.

## Workflow

1. Start the target app locally and confirm its port. Start it detached — see
   *Starting the app* below.
2. Run `mp.cmd start --port <port>` for a built app, or `mp.cmd start --port <port> --dev` for a Vite/Webpack development server in PowerShell.
3. Return the printed preview URL as a **bare line of its own**. Never wrap it
   in a code block, backticks, or any other markdown: many phone clients render
   code blocks unselectable and unclickable, and a link the user cannot copy is
   a link that never arrives. This has already cost one session.
4. Use `mp status` to inspect active previews.
5. Use `mp capture --port <port>` when a screenshot or browser diagnostics are needed.
6. Use `mp stop --port <port>` when the user is finished.

`mp.cmd start` narrates the stage it is waiting on and returns a link only after
cloudflared has registered an edge connection — a url on its own is not a
reachable preview and shows up as HTTP 530 on the phone. If it times out, the
message says whether the daemon is still trying; `mp.cmd status` then reports
whether it got there. Use `mp.cmd start --json` when the URL is going to be
parsed rather than read.

When diagnosing a blank dev-server preview, inspect the `FAILED REQUESTS`
section from `mp capture`: each entry includes the full URL, status code, and
resource type, and console-only resource errors are folded in with the URL they
refer to. Favicons and source maps are listed separately as ignorable. A Vite
module URL containing `?t=<timestamp>` is not a preview token when a valid
`mp_session` cookie is present, and is forwarded normally.

For a screen that only exists after an API call, use
`mp.cmd capture --network-idle` or `mp.cmd capture --wait-for "<selector>"`;
add `--full-page` to see past the first screen and `--strict` to make a page
with errors fail the command.

By default the link stays exchangeable for the preview's whole `--ttl`, so
reopening the same URL keeps working. For sensitive apps, use a short lifetime
and optionally a tighter exchange window:

```powershell
mp.cmd start --port 8080 --dev --ttl 120 --grace 20
```

## Starting the app

Step 1 is where a preview session goes wrong hours after it looked finished.
Start the user's app as a genuinely detached process:

```powershell
Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList "/c", "npm run dev" -WorkingDirectory <app-dir> -RedirectStandardOutput <log>
```

Do not start it as a tracked background task. A tracked task holds the turn open
for as long as the process lives, and when the process finally dies — hours
later, on a crash nobody is watching — its exit notification wakes the
conversation back up and the original request gets answered a second time. One
session started a backend and a dev server as tracked tasks, stopped only the
dev server before handing over the link, and was resurrected five and a half
hours later when the backend hit a Windows socket error. The user saw a single
turn that had apparently "worked" for 5h28m and then re-issued its first answer.

If a tracked background task is unavoidable, stop every one of them before
returning the link. Leaving one behind is what causes the delayed replay.

`mp` itself is safe here: the daemon is spawned detached with its stdio
discarded, so the harness never tracks it and it expires quietly at the end of
its TTL.

## Frontend development

When a frontend dev server calls an API at `127.0.0.1`, remember that the
browser on the phone treats `127.0.0.1` as the phone itself. Prefer relative API
URLs such as `/api/...` and configure the local dev server to proxy them to the
backend.

The preview does not forward WebSocket upgrades, so HMR does not work through
it at all — this is not a flaky-connection problem to retry. After a code
change, tell the user to reload the page on the phone.

Repeat captures never overwrite each other: screenshots are numbered
`shot-1.png`, `shot-2.png`, … within a preview's gallery, so a link already
sent to the phone keeps showing what it showed when it was sent.

## Credentials

When the task needs a value only the user has — an access key, a password, a
token, a database URL — do not ask for it in the chat. In a remote session the
user cannot reach the machine, and a value typed into the chat lands in the
transcript, in your context and in every later turn. Collect it through
`mp secret` instead:

1. Declare what you need and what you intend to do with it:

   ```powershell
   mp.cmd secret ask --purpose "配置 OSS 上传" --field OSS_ACCESS_KEY_ID --field OSS_ACCESS_KEY_SECRET --field OSS_BUCKET:text --use "npm run deploy" --use "node scripts/check-oss.js"
   ```

   A field is `secret` by default (masked, redacted from output); `:text` for a
   value that is fine to see, such as a bucket name; `:multiline` for a PEM key.
   Each `--use` is a command line, quoted as one argument. Declare every command
   you will need now — each later addition costs the user another link.
   If the user saved these values for this project earlier, `ask` may print
   `used saved values — no phone needed` and no link at all: they chose "直接用"
   on the phone, the slot is already filled, go straight to step 4. Or it
   prints a *confirm* link — one tap for them, no retyping. Either way you
   asked the same way; saving is decided on the phone, never by you.
2. Return the printed link as a **bare line of its own**, exactly like a
   preview link, and tell the user in one sentence what the form asks for.
3. `mp.cmd secret wait --id <id>` blocks until the phone has submitted. It
   reports each field's length and an 8-hex SHA-256 prefix, and the uses the
   user actually ticked. There is no command that prints a value; do not go
   looking for one, and do not ask the user to confirm a value by repeating it.
4. Run the tool that needs the values:

   ```powershell
   mp.cmd secret run --id <id> -- npm run deploy
   ```

   The command must be, word for word, one the user ticked. The values arrive
   as environment variables; stdout and stderr come back with the values
   redacted; the exit code is passed through. Leave the key empty in `.env` —
   `dotenv` does not override a variable already in the environment.
5. Need another command? `mp.cmd secret ask --id <id> --use "<command>"` sends
   the phone a link to approve just that; the values are not re-entered.
6. `mp.cmd secret forget --id <id>` when the task is done. `mp.cmd secret status`
   lists what is held.

Never wrap the run in a shell (`sh -c`, `cmd /c`, `powershell -Command`,
`node -e`) or pass anything that prints the environment: the hook refuses it,
and it is the wrong shape anyway — the values are for the tool, not for you.

When a tool wants the value in a config file, pick the first of these that works:

1. The tool reads environment variables (dotenv, docker compose, Spring's
   `${VAR}`, Prisma's `env()`, most CLIs): write the reference or leave the
   key empty in the file, and `mp secret run` injects it. Nothing on disk.
2. The tool has its own configure step that reads the value from the
   environment or stdin: run that step through `mp secret run`.
3. Only a real value in a file will do: write a **template** with
   placeholders, never the value — `{{mp:NAME}}` as is, `{{mp:NAME|json}}` as a
   quoted JSON/YAML/TOML string, `{{mp:NAME|url}}` inside a connection string.
   Declare it on the ask with `--render config.yml.tpl=config.yml`, then
   `mp.cmd secret run --id <id> --render config.yml.tpl=config.yml -- npm start`
   writes the file, runs the command and deletes the file when it exits. The
   output file must be in `.gitignore` or mp refuses to write it. You cannot
   read it — the hook refuses — so to change the config edit the template and
   run again, and to check what came out run `mp.cmd secret peek --id <id> config.yml`,
   which shows it redacted.

Do not read the vault under the mp state directory or try to decrypt it; to
see what is saved, `mp.cmd secret saved`. If a check command fails with an
authentication error after saved values were used, the saved value is
probably stale: ask again with `--refill`.

Tell the user, once, that a leaked value is bounded by the credential itself:
a sub-account scoped to one bucket, an STS token or a single-schema database
user limits what any mistake can cost, and this workflow does not change that.

## Decisions

When the answer you need is a **choice among three or more options, two or more
values, an ordering, or a review of more than a screen of content**, do not
write it out in the chat. On a phone that is a wall of text the user has to
read, hold in their head, and answer by typing — and what comes back is prose
you then have to interpret. Put it on a page instead. A single yes/no, or one
field, stays in the chat; this is a help, not a toll gate on every question.

```powershell
mp.cmd interaction ask --purpose "本周四件事的顺序" --html .\decide.html
mp.cmd interaction wait --id i-7f3a1c
```

`ask` checks the page, serves it on a fresh tunnel and prints a link — hand it
over as a **bare line of its own**, like a preview link. `wait` blocks until the
phone submits, then prints the answers as JSON.

If you cannot make the page — no shell, no way to write a file, `mp` missing —
say so in one line and stop looking for a way round it. Then answer in the chat
the way the page would have: three or four lines, one per option, with what it
costs and what you would pick, and offer the detail on request. The full
comparison as tables and paragraphs is exactly the wall the page was meant to
avoid; not having the page does not make it any easier to read on a phone.

### Writing the page

One self-contained HTML file. If you have a design skill, follow it for the
visual work; everything below is what this CLI requires regardless.

**Explain before you ask, and draw rather than write.** Lead with why you need
them, what each choice changes, and what it costs — explained like the reader
knows nothing about the area: big pictures, few words, every term explained
once in a single plain sentence.

If it can be drawn, do not write it. A timeline for "when", two bars on one
axis for a trade-off, a before/after for an edit, boxes and arrows for a
dependency. Draw them in HTML/CSS or inline SVG — mark a CSS-drawn one with
`<figure>` so the check can see it — and fold the original wording and the
evidence behind a `<details>` so it is there without being in the way.

`ask` warns when a page runs to hundreds of words with nothing drawn. Take the
warning seriously: that page is a chat message with margins, it costs a tunnel
and a tap, and the chat was already free. The layout being good is not the
point — a wall of text in a nicer font is still a wall of text on a 390 px
screen.

**Written for a phone, opened just as often on a laptop.** Design for 390 px
and leave the desktop to the injected base stylesheet: it caps `<body>` at
`--mp-content-width` (46 rem) and centres it, so the same link on a monitor is
a readable column instead of a line of text as wide as the screen. There is
nothing to add and nothing to fight — a page that wants a different measure
sets `:root{--mp-content-width:56rem}`, and a deliberately full-bleed one opts
out with `<body data-mp-layout="full">`. Size everything inside it the same
way: percentages, `clamp()`, and
`grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))` for a row of option
cards, rather than fixed pixel widths that only look right at one of the two
sizes.

**Hard constraints** — `ask` refuses the page and tells you which one you hit:

- One file, ≤ 300 KB, starting `<!doctype html>`, with `<html lang>` and a
  viewport meta.
- **No external resources at all**: no CDN script, stylesheet, web font or
  image, and no `https:` inside CSS. The page is served under
  `default-src 'none'` over a tunnel; anything fetched fails closed. That rules
  out React and Babel, which only load from a CDN — write plain HTML, CSS and JS.
- No `<script type="module">`, no `<form action>`, no `<base href>`.
- Do not define `window.MP` or `window.MP_REQUEST`; both are injected.

**Carrying the answers** — any one of these; the injected bridge collects them:

- Give form controls a `name`. Checkbox groups become arrays, `type="number"`
  becomes a number, `required` is enforced before an answer is accepted.
- For a custom control — a sortable list, a diff with per-paragraph notes —
  call `MP.set("order", [...])`, or put JSON in `data-mp-value` on an element
  with a `name`.
- Collection is scoped to `[data-mp-form]` if you mark one, otherwise `<body>`.

**Submitting** — put `data-mp-submit` on the button. Add
`data-mp-disposition="needs_clarification"` and `data-mp-reason="<why>"` to a
second one so the user can say the question itself is wrong; that path does not
require the form to be complete. Give them a "还没想好" option per item rather
than forcing an answer. Mark an element `data-mp-receipt` and the receipt lands
there instead of in a banner at the bottom.

The bridge also saves a draft as they type — to the phone and back to this
machine — so a reload keeps their work and `wait` can report how far they got.
Restore a custom control from it on the `mp:ready` event via `MP.draft(name)`.

### Waiting

`wait` blocks for up to `--timeout` seconds (540 by default, sized for a tool
call that may not block for more than ten minutes). It **exits 0 in every
normal case** — read `status`, do not read the exit code:

- `submitted` — the answer is in `answers`, with `disposition` and any
  `reason`. Act on it.
- `waiting` — they are still reading. Run `wait` again. `draft` shows what is
  filled in so far, which is worth saying out loud: "你已经定了三条，还差排序".
- `expired_link` — the link lapsed unanswered. The draft survives; reopen with
  `mp.cmd interaction ask --id <id> --html <file>`.

There is a fourth way an answer can arrive, and it does not come through
`wait` at all. When the phone cannot submit — cloudflared dropped the edge,
the link lapsed — the page retries on its own for half a minute and then
turns the answer into text the user can paste into the chat: a block headed
`【mp interaction 回传 · <id> · 第 N 版】`, a readable list, and one
`mp-answer: {"id":…,"disposition":…,"answers":{…}}` line.

**A pasted block of that shape is the answer.** Read `answers` from the
`mp-answer:` line, treat `disposition` exactly as you would from `wait`, act
on it, and run `mp.cmd interaction close --id <id>`. Do not re-ask, and do not
send a new link: they already filled the page in, on a phone, and the only
thing that failed was the wire home. Asking them to do it again is the
failure this fallback exists to prevent.

Re-asking with `--id` keeps one thread and bumps the revision, so a tab still
showing the old page cannot answer the new question. Use it after a
`needs_clarification`: respond to their objection first, then send the new page.

Reading the same answer twice is fine and returns the same thing — if a
compaction lost it, ask again rather than treating it as gone.
`mp.cmd interaction status` lists what is open; `mp.cmd interaction close --id <id>`
ends one early.

### The hooks that trigger this

Three, and they are a safety net, not the plan — recognising the moment
yourself is cheaper than all of them:

- The `SessionStart` context states the rule above in a remote session.
- A `PreToolUse` hook refuses a question tool call carrying three explained
  options, or two substantial questions, or one long one, and tells you to use
  a page. It only fires in a remote session.
- A `Stop` hook catches a long message that ends in a question when no page is
  open, and asks for one. It gives up after twice in a session — if the message
  really is not a decision for the user, say so in one line and stop.

## Safety

- Never expose a terminal, ChatGPT, or the preview tool itself.
- Treat the URL — now issued as `?__mp_token=<token>`, with the older `?t=`
  form still accepted for links already sent — as a bearer credential.
- Do not share the token or preview URL with anyone who should not access the app.
- Stop the preview when finished.
- Do not use this workflow to access data without authorization.
