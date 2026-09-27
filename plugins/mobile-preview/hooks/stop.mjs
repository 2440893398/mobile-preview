import process from 'node:process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPayload } from './hook-io.mjs'
import {
  confirmReason, hasOpenInteraction, htmlRepliesOn, readMark, recordConfirmAsk, remoteStatus, stateDir, writeMark,
} from './session-mark.mjs'
import { weigh } from './cjk.mjs'

// The last of three triggers, and the only one that fires after the fact.
//
// It exists for the shape this whole feature was built for: the model writes
// two thousand words laying out five decisions, ends with "which do you
// prefer", and stops — leaving the person to read all of it on a phone and
// type an answer back. The other two triggers try to prevent that; this one
// notices it happened and asks for the page before the user has to.
//
// The tokens for that message are already spent, so this is a fallback, not a
// plan. On Codex it is the main line of defence anyway: that host's own
// instructions steer a must-answer question into exactly this shape.
//
// Everything here is about not becoming a nuisance. It reads the shape of the
// message, never its subject; it stays out of the way when a page is already
// open; and it gives up after two attempts in a session rather than arguing
// with a model that has a reason to write this way.

// Weighted, not counted: the same message runs about a third as many
// characters in Chinese, so a raw 1500 would have meant this hook needed a
// message three times longer before it fired — and on Codex it is the only
// trigger there is.
const LONG_MESSAGE = 1_500
// The tail stays a raw slice. All it looks for is whether the message ends by
// asking, and a window that is generous in CJK errs toward firing, which is
// the safe direction for a hook that only ever asks for a better page.
const TAIL = 300
const MAX_BLOCKS = 2

// An enumerated list at the end of a long message: "1." / "1)" / "- " / "(a)"
// at the start of a line, which is how options get written out in prose.
const ENUMERATED = /^[ \t]*(?:[-*•]|\(?[0-9a-dA-D][.)、）])\s+\S/m
const ASKS = /[?？]/

const REASON = 'That message asks the user to decide, and it is long enough that reading it on a phone '
  + 'and typing an answer back is the slow way round. Turn it into a page: write one self-contained '
  + 'HTML file with the choices as controls, run `mp interaction ask --purpose "<why>" --html <file>`, '
  + 'hand over the printed link as a bare line, then `mp interaction wait --id <id>` and act on the '
  + 'JSON it prints. See the mobile-preview skill for what the page must contain. '
  + 'If this really is not a decision for them to make, say so in one line and stop.'

// A user-facing local address must never be the only preview link unless the
// session is known to be at this computer. The agent cannot reliably tell
// whether a Codex prompt came from the phone, so an unknown device gets a
// remote-capable link when a page is being handed over. A reply that already
// includes the tunnel link may mention localhost too.
//
// The path part is plain ASCII URL characters only. Markdown (`code`, **bold**)
// and Chinese prose, which puts no space after a link, would otherwise run
// straight into the URL and make a correct pair of links fail to match.
const LOCAL_ADDRESS = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?![\w-]|\.\w)(?:[/?#][\w\-.~:/?#@!$&+,;=%]*)?/gi
const REMOTE_ADDRESS = /\bhttps:\/\/[a-z0-9-]+\.trycloudflare\.com(?:[/?#][\w\-.~:/?#@!$&+,;=%]*)?/gi

// Sentence punctuation that ends up glued to a URL's tail.
function cleanUrl(raw) {
  return new URL(raw.replace(/[.,;:!?]+$/, ''))
}

const LOCAL_REASON = 'That message offers a localhost / 127.0.0.1 page for the user to open. '
  + 'It only opens on this computer. Expose it first: `mp start --port <port>` '
  + '(add `--dev` for a Vite/Webpack dev server; `mp start --serve <dir>` for plain files) and give them '
  + 'the remote preview URL it prints as a bare line. You may also include the local URL for this computer. '
  + 'If the local URL points at a subpage, preserve that path in the remote link. '
  + 'For a decision page, give the first link `mp interaction ask` printed, not the 127.0.0.1 one. '
  + 'If the address is not something for them to open — a config value, a log line — carry on.'

// The same page at the desk. A wall of options is no easier to weigh on a
// monitor than on a phone — the page is what draws the comparison and turns
// the answer into JSON — so a known-local session gets it too, just without
// the tunnel, which there is only a slower way to reach a port they can open.
const LOCAL_DECISION_REASON = 'That message asks the user to decide, and it is long enough that weighing it '
  + 'in the chat is the slow way round. The user is at this computer, so put it on a local page: write one '
  + 'self-contained HTML file with the choices as controls, run '
  + '`mp interaction ask --local --purpose "<why>" --html <file>`, hand over the 127.0.0.1 link it prints '
  + '(and open it in your browser pane if you have one), then `mp interaction wait --id <id>` and act on the '
  + 'JSON it prints. See the mobile-preview skill for what the page must contain. '
  + 'If this really is not a decision for them to make, say so in one line and stop.'

const CONFIRM_LEAD = 'This reply ends with a substantial decision for the user.'

// ---- the switch: `mp html on` ----
//
// Not a decision, just a lot to read: a comparison in tables, an
// investigation in sections. Off by default and only ever the user's choice —
// the hook cannot tell a reply that reads better as a page from one that is
// long because the work was, and guessing would put a toll on every long
// answer. Once they have said they want it, the shape is enough.
const REPORT_LONG = 2_400
const REPORT_VERY_LONG = 6_000
const TABLE = /^[ \t]*\|.*\|[ \t]*\r?\n[ \t]*\|?[ \t]*:?-{3,}/m
const HEADING = /^#{1,6}[ \t]+\S/gm

export function looksLikeAComplexReply(message) {
  const text = String(message ?? '')
  const size = weigh(text)
  if (size > REPORT_VERY_LONG) return true
  if (size <= REPORT_LONG) return false
  return TABLE.test(text) || (text.match(HEADING) || []).length >= 3
}

const REPORT_WHAT = 'The user has turned on HTML replies (`mp html on`), and that reply is long and structured '
  + 'enough to read better as a page. Write the same content as one self-contained HTML file (inline CSS, no '
  + 'external resources) in the system temp directory — draw what can be drawn: tables as tables, comparisons '
  + 'as bars or side-by-side cards, flows as boxes and arrows, detail folded into <details>. '

const REPORT_LOCAL = `${REPORT_WHAT}The user is at this computer: show the file with your host's own way of `
  + 'rendering an HTML file if it has one (e.g. a send-file tool with display "render"), otherwise give its '
  + 'absolute path as a link. '

const REPORT_REMOTE = `${REPORT_WHAT}The user may not be at this computer: serve its directory with `
  + '`mp start --serve <dir>` and give the preview URL it prints as a bare line. '

const REPORT_TAIL = 'Then end the turn with a two- or three-line summary and the link — not the full reply again. '
  + 'If this reply is not worth a page (mostly code to copy, a log, a quick answer that happens to be long), '
  + 'say so in one line and stop.'

function matchingRemoteLink(text, local, env) {
  const port = Number(local.port || (local.protocol === 'https:' ? 443 : 80))
  const root = stateDir(env)
  const candidates = [join(root, 'previews', `${port}.json`)]
  try {
    for (const name of readdirSync(join(root, 'interactions'))) {
      if (/^i-[a-z0-9]+\.json$/.test(name)) candidates.push(join(root, 'interactions', name))
    }
  } catch {
    // No interaction directory is common for a plain app preview.
  }
  for (const file of candidates) {
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'))
      if (Number(state.targetPort ?? state.formPort) !== port || !state.tunnelUrl || !state.sessionToken) continue
      if (state.expiresAt && Date.now() > state.expiresAt) continue
      for (const raw of text.match(REMOTE_ADDRESS) || []) {
        const link = cleanUrl(raw)
        if (link.origin !== new URL(state.tunnelUrl).origin) continue
        if (link.pathname !== local.pathname || link.hash !== local.hash) continue
        if ([...local.searchParams].some(([key, value]) => !link.searchParams.getAll(key).includes(value))) continue
        if (link.searchParams.get('__mp_token') === state.sessionToken
          || link.searchParams.get('t') === state.sessionToken) return true
      }
    } catch {
      // Missing or unreadable state cannot prove that a link is usable.
    }
  }
  return false
}

export function handsOverLocalAddress(message, env = process.env) {
  const text = String(message ?? '')
  const urls = text.match(LOCAL_ADDRESS) || []
  return urls.some((url) => {
    try {
      return !matchingRemoteLink(text, cleanUrl(url), env)
    } catch {
      return true
    }
  })
}

export function looksLikeAnUnansweredDecision(message) {
  const text = String(message ?? '')
  if (weigh(text) <= LONG_MESSAGE) return false
  const tail = text.slice(-TAIL)
  return ASKS.test(tail) || ENUMERATED.test(tail)
}

export function decide(payload, {
  remote = false, confirmed = true, local = false, blocks = 0, pageOpen = false, html = false, env = process.env,
} = {}) {
  // Already blocked once and re-entered: whatever the model does next, this
  // hook must not be what decides it cannot finish.
  if (payload?.stop_hook_active) return null
  // A user-facing page link must work on another device unless this session
  // is known to be at this computer: a local user told where their dev server
  // is must not be pushed into opening a public tunnel. Preview links do not
  // use the decision retry budget.
  if (!local && handsOverLocalAddress(payload?.last_assistant_message, env)) {
    return { block: LOCAL_REASON, kind: 'preview' }
  }
  // The model did open a page — the message is describing it, not replacing
  // it. These two read almost identically in the text and are opposites.
  if (pageOpen) return null
  const message = payload?.last_assistant_message
  if (looksLikeAnUnansweredDecision(message)) {
    if (blocks >= MAX_BLOCKS) return null
    if (!confirmed) return { block: confirmReason(payload?.session_id, CONFIRM_LEAD), kind: 'confirm' }
    if (remote) return { block: REASON, kind: 'decision' }
    if (local) return { block: LOCAL_DECISION_REASON, kind: 'decision' }
    return null
  }
  // Not budgeted like a decision: the user asked for this, and
  // stop_hook_active already keeps it from arguing with its own answer.
  if (html && looksLikeAComplexReply(message)) {
    return { block: (local ? REPORT_LOCAL : REPORT_REMOTE) + REPORT_TAIL, kind: 'report' }
  }
  return null
}

async function main() {
  const payload = await readPayload()
  if (!payload) return

  const mark = readMark(payload?.session_id)
  const verdict = decide(payload, {
    ...remoteStatus(mark),
    blocks: Number(mark?.blocks ?? 0),
    pageOpen: hasOpenInteraction(),
    html: htmlRepliesOn(),
  })
  if (!verdict) return

  if (verdict.kind === 'decision') writeMark(payload.session_id, { blocks: Number(mark?.blocks ?? 0) + 1 })
  if (verdict.kind === 'confirm') recordConfirmAsk(payload.session_id, mark)
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason: verdict.block })}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
