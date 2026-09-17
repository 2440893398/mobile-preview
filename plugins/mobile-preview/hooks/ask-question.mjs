import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readPayload } from './hook-io.mjs'
import { readMark } from './session-mark.mjs'
import { weigh } from './cjk.mjs'

// The second of three triggers, and the most precise one: the model has
// already decided it needs the person, and is about to put the question in
// the chat. That is the moment to say "this one is too big to answer there".
//
// Precise, but not sufficient on its own. Claude Code reaches here for
// anything it wants to ask; Codex's own instructions tell it to write a
// question it must have answered as plain prose rather than call this tool at
// all, so on that host most of what we want to catch never arrives. The Stop
// hook is what covers that, at the cost of the prose having been written.
//
// The test is the shape of the question, never its subject. A hook cannot
// tell whether a decision is important, and a hook that guessed would be
// wrong in both directions; how much there is to read, and how many ways
// there are to answer, it can measure.

// Three or more options are a comparison, and a comparison whose options each
// need a sentence of explanation is one the chat renders as a wall of text.
const MANY_OPTIONS = 3
const EXPLAINED_OPTIONS = 150
// Two questions at once are almost always related — answering one changes what
// the other means — and a chat has no way to show that.
const MANY_QUESTIONS = 2
const SUBSTANTIAL = 250
// One question that simply takes this much reading.
const LONG = 400


const REASON = 'This question is large enough that answering it in the chat means reading a wall of text. '
  + 'Put it on a page instead: write one self-contained HTML file and run '
  + '`mp interaction ask --purpose "<why>" --html <file>`, hand over the printed link as a bare line, '
  + 'then `mp interaction wait --id <id>` and act on the JSON it prints. '
  + 'See the mobile-preview skill for what the page must contain.'

function strings(value, depth = 0) {
  if (depth > 4) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((v) => strings(v, depth + 1))
  if (value && typeof value === 'object') return Object.values(value).flatMap((v) => strings(v, depth + 1))
  return []
}

function size(value) {
  return strings(value).reduce((n, s) => n + weigh(s), 0)
}

// Both hosts nest the questions under `questions`; what sits inside one
// differs (Claude Code: question/header/options[{label,description}], Codex:
// a title and its answers, which may be bare strings), so nothing below reads
// a field by name.
export function shapeOf(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : []
  const options = questions.map((q) => (Array.isArray(q?.options) ? q.options : []))

  return {
    count: questions.length,
    load: size(questions),
    maxOptions: Math.max(0, ...options.map((o) => o.length)),
    // Per question, not across all of them: three explained options in one
    // question is the wall, three questions with one option each is not.
    heaviestOptions: Math.max(0, ...options.map((o) => size(o))),
  }
}

export function decide({ tool_name: tool, tool_input: input } = {}, { remote = false } = {}) {
  // A person at this machine has a working answer already: the host's own
  // prompt, in the terminal they are looking at.
  if (!remote) return null
  if (!/^(AskUserQuestion|request_user_input(_async)?)$/.test(String(tool ?? ''))) return null

  const s = shapeOf(input)
  if (!s.count) return null

  const tooMuchToCompare = s.maxOptions >= MANY_OPTIONS && s.heaviestOptions > EXPLAINED_OPTIONS
  const tooManyAtOnce = s.count >= MANY_QUESTIONS && s.load > SUBSTANTIAL
  const tooMuchToRead = s.load > LONG
  if (!tooMuchToCompare && !tooManyAtOnce && !tooMuchToRead) return null

  return { deny: REASON, shape: s }
}

async function main() {
  const payload = await readPayload()
  if (!payload) return

  const mark = readMark(payload?.session_id)
  const verdict = decide(payload, { remote: Boolean(mark?.remote) })
  if (!verdict) return

  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.deny,
    },
  })}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
