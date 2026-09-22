---
name: mobile-preview
description: 'Use whenever a locally running app has to be opened, shown, verified or screenshotted by someone who is not at this machine — every time a localhost or 127.0.0.1 URL would otherwise be handed to the user, and in any remote session (Happy, phone) where such an address cannot be opened at all. Triggers on "on my phone", "手机上看看", "看看效果", "preview", "预览一下", "send me the link", "把链接发我", "screenshot", "截图", "mobile UI", "localhost 打不开", "这个地址打不开", "stop the preview", "关掉预览", and on mp start / mp capture / mp stop. Also use whenever such a session needs a credential from the user — a password, API key, AccessKey, token, database URL: "密码给你", "把 key 发你", "需要账号密码", "填一下配置", "credentials", "API key" — so it is collected with mp secret instead of typed into the chat. Also use whenever a decision belongs to the user and would otherwise be written out as a wall of text: three or more options to compare, several values to set, items to put in order, a draft to review — "你来定", "帮我选", "哪个好", "排个序", "看看这段改得对不对", "which one", "help me decide", "review this" — so it is asked with mp interaction as a page instead.'
---

# mobile-preview

Use `mp start` to expose the local app, `mp capture` to collect screenshots and diagnostics, and `mp stop` to tear everything down. Video capture requires `ffmpeg` on `PATH`.

## When to use

- The user just changed frontend code and wants to verify it on a phone.
- The user asks what the app looks like now.
- You need to check a page yourself before handing results back.
- The session is remote — started through Happy — and a local address would
  otherwise be the answer. There the user is on a phone, `localhost` points at
  the phone itself, and this is the only way to hand the app over. It applies
  whether or not the user names the plugin; the plugin's SessionStart hook
  detects the session from `CLAUDE_CODE_EXECPATH` / `HAPPY_*`, or from the
  process tree under Codex, and says so.

## Credentials

When the task needs a value only the user has — an access key, a password, a
token — never ask for it in the chat. Run
`mp secret ask --purpose "<why>" --field NAME --use "<command>"`, return the
printed link as a bare line, then `mp secret wait --id <id>` and
`mp secret run --id <id> -- <command>`. `wait` reports lengths and SHA-256
prefixes, never values, and no command prints one. `run` only accepts a command
the user ticked on the phone, word for word; more commands are approved with
`mp secret ask --id <id> --use "<command>"`. Never wrap a run in `sh -c` /
`cmd /c` / `node -e` or pass anything that prints the environment.
`mp secret forget --id <id>` when done.

If the user saved the values for this project, `ask` may come back already
filled (`used saved values — no phone needed`) or with a one-tap confirm link;
saving is chosen on the phone, never by you. A tool that only reads its key
from a config file gets a template with `{{mp:NAME}}` placeholders and
`--render TPL=OUT` on both `ask` and `run` — never a file you write the value
into yourself. The rendered file is off limits to you; `mp secret peek` shows
it redacted. Never read or decrypt the vault; `mp secret saved` lists it.

## Decisions

When the answer you need is a choice among three or more options, two or more
values, an ordering, or a review of more than a screen of content, do not write
it out in the chat — on a phone that is a wall of text to read and an answer to
type, and what comes back is prose you then have to interpret. Write one
self-contained HTML page, run `mp interaction ask --purpose "<why>" --html <file>`,
return the printed link as a bare line, then `mp interaction wait --id <id>` and
act on the JSON. A single yes/no stays in the chat.

If you cannot make the page — no shell, no way to write a file, `mp` missing —
say so in one line and stop looking for a way round it. Then answer in the chat
the way the page would have: three or four lines, one per option, with what it
costs and what you would pick, and offer the detail on request. Tables and
paragraphs are the wall the page was meant to avoid, page or no page.

The page is checked before the link is issued: one file under 300 KB, **no
external resources at all** (no CDN, no web font, so no React or Babel), no
`<form action>`, no `<script type="module">`. Give controls a `name`, or call
`MP.set(name, value)` for a custom one; put `data-mp-submit` on the button, and
on a second one add `data-mp-disposition="needs_clarification"` so the user can
say the question itself is wrong.

Write it for a 390 px phone; the desktop is already handled. The injected base
stylesheet caps `<body>` at `--mp-content-width` (46 rem) and centres it, so
the same link opened on a monitor is a readable column rather than a line of
text as wide as the screen. Retune it with `:root{--mp-content-width:56rem}`,
opt out with `<body data-mp-layout="full">`, and size what is inside fluidly —
`clamp()`, percentages, `repeat(auto-fit,minmax(16rem,1fr))` — instead of fixed
pixel widths.

**Draw it, do not write it.** Explain like the reader knows nothing about the
area, with big pictures and few words: if it can be drawn, do not write it —
a timeline for "when", two bars on one axis for a trade-off, a before/after for
an edit, boxes and arrows for a dependency. Draw them in HTML/CSS or inline
SVG, mark a CSS-drawn one with `<figure>`, and explain each term once in a
single plain sentence. `ask` warns when a page is hundreds of words with
nothing drawn, because that page is a chat message with margins — and the chat
was already free.

`wait` exits 0 in every normal case — read `status`, not the exit code.
`waiting` means they are still reading, so run it again; its `draft` says how
far they got. `expired_link` means reopen with `--id <id>`. Re-asking with
`--id` bumps the revision so a stale tab cannot answer the new question. The
full page contract is in the plugin's skill.

If the phone cannot submit — the tunnel dropped, the link lapsed — the page
retries on its own and then hands the user a block starting
`【mp interaction 回传 · i-xxxxxx` with an `mp-answer: {...}` line in it. Pasted
into the chat, **that block is the answer**: act on it, run
`mp interaction close --id <id>`, and do not send a fresh link asking them to
fill the same page in a second time.

## Workflow

To show a **page** — one HTML file, or a folder of built files — do not start a
server: `mp start --serve <path>` picks a free port, serves it from inside the
preview daemon, and takes it down with the preview. A directory is served whole;
a single file is served alone, so its siblings stay off the url. It refuses
`--port` (it chooses one) and `--dev` (it serves files).

For a **running app**:

1. Start the target app locally, detached — see the rule below.
2. Run `mp start --port <port>`. It prints the stage it is waiting on and only
   returns a link once cloudflared has registered with the edge; `mp start --json`
   gives `{status, url, port, expiresAt}` for programmatic use.
3. Run `mp capture` or `mp capture <url> --steps <file> --video`. Use `--video` only when `ffmpeg` is available.
4. Paste the markdown image lines from capture output back into the reply, and
   the preview URL as a bare line of its own.
5. Run `mp stop` after the user is done.

If anything refuses to start, run `mp doctor` before guessing: it separates a
missing CLI from a CLI that is installed but not on this shell's PATH, and both
from a missing cloudflared, browser or ffmpeg.

For an app whose first screen is rendered after an API call, use
`mp capture --network-idle` or `mp capture --wait-for "<selector>"` rather than
accepting whatever was on screen half a second after load. `--full-page`
captures past the first screen, and `--strict` makes the command fail when the
page had console errors or failed requests.

## Rules

- **Start the app detached, never as a tracked background task.** Use
  `Start-Process -WindowStyle Hidden` on Windows or `nohup ... &` elsewhere. A
  tracked background task holds the turn open for as long as the process lives,
  and its exit notification — arriving hours later when the process crashes
  unattended — wakes the conversation up and answers the original request a
  second time. One session left a backend running that way and was resurrected
  five and a half hours later, replaying its own first reply. If a tracked task
  is unavoidable, stop every one of them before returning the link. `mp`'s own
  daemon is detached with its stdio discarded and never does this.
- **Stop what you started.** `mp stop` ends mp's daemon and tunnel and nothing
  else: a server you started keeps its port forever. Seven such leftovers were
  found on one machine, the oldest three days old, and the damage was not
  memory — a later preview pointed at a port one of them still held, and the
  user opened a fresh link onto a page from a previous task. For a plain page
  use `--serve` so there is nothing to leak; for a real app, stop it in the
  same breath as `mp stop`. `mp status` names what each preview serves.
- **Output the preview link as a bare line.** Never wrap it in a code block,
  backticks, or any other markdown. Many phone clients render code blocks
  unselectable and unclickable, and a link the user cannot copy is a link that
  never arrives. This has already cost one session.
- The link stays exchangeable for `--grace` minutes (default 10) after its
  first use, so a chat client that prefetches it does not lock the user out.
  After that only the cookie works. Do not hand the same link to two people
  expecting both to get in.
- Links are issued as `?__mp_token=<token>`. The older `?t=<token>` form is
  still accepted for links already in someone's history, but never issue it:
  Vite uses `?t=<timestamp>` for its own module URLs, and a valid session is
  allowed to request those.
- Treat the whole preview URL as a bearer credential.
- Never point `--port` at the preview tool itself, ChatGPT, or any terminal.
- Keep the tunnel temporary.
- Do not share any token except through the CLI output.
