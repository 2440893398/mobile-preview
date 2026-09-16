import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readPayload } from './hook-io.mjs'
import { hasOpenInteraction, readMark, writeMark } from './session-mark.mjs'

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

const LONG_MESSAGE = 1_500
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

export function looksLikeAnUnansweredDecision(message) {
  const text = String(message ?? '')
  if (text.length <= LONG_MESSAGE) return false
  const tail = text.slice(-TAIL)
  return ASKS.test(tail) || ENUMERATED.test(tail)
}

export function decide(payload, {
  remote = false, blocks = 0, pageOpen = false,
} = {}) {
  // Already blocked once and re-entered: whatever the model does next, this
  // hook must not be what decides it cannot finish.
  if (payload?.stop_hook_active) return null
  if (!remote) return null
  if (blocks >= MAX_BLOCKS) return null
  // The model did open a page — the message is describing it, not replacing
  // it. These two read almost identically in the text and are opposites.
  if (pageOpen) return null
  if (!looksLikeAnUnansweredDecision(payload?.last_assistant_message)) return null
  return { block: REASON }
}

async function main() {
  const payload = await readPayload()
  if (!payload) return

  const mark = readMark(payload?.session_id)
  const verdict = decide(payload, {
    remote: Boolean(mark?.remote),
    blocks: Number(mark?.blocks ?? 0),
    pageOpen: hasOpenInteraction(),
  })
  if (!verdict) return

  writeMark(payload.session_id, { blocks: Number(mark?.blocks ?? 0) + 1 })
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason: verdict.block })}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
