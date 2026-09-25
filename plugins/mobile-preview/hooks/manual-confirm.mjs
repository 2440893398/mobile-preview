import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readPayload } from './hook-io.mjs'
import { readMark, writeMark } from './session-mark.mjs'

// Only an answer to our pending question counts. Ordinary messages about a
// phone or a computer must never silently change the user's session choice.
export function confirmedRemoteAnswer(prompt) {
  const answer = String(prompt ?? '').trim()
  if (/^(?:远端|手机|remote)$/i.test(answer)) return true
  if (/^(?:本机|电脑|local)$/i.test(answer)) return false
  return null
}

export function rememberConfirmation(payload, env = process.env) {
  const sessionId = payload?.session_id
  const mark = readMark(sessionId, env)
  if (typeof mark?.manualRemote === 'boolean') {
    // Keep an active task's explicit choice alive without retaining abandoned
    // session files forever. This runs only on user messages, not tool calls.
    writeMark(sessionId, {}, env)
    return null
  }
  if (!mark?.awaitingManualRemote) return null
  const manualRemote = confirmedRemoteAnswer(payload?.prompt)
  if (manualRemote === null) return null
  return writeMark(sessionId, { manualRemote, awaitingManualRemote: false }, env)
}

async function main() {
  const payload = await readPayload()
  const saved = payload && rememberConfirmation(payload)
  if (!saved) return
  const mode = saved.manualRemote ? 'remote' : 'local'
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `The user confirmed ${mode} mode for this session. Continue the decision you were preparing; use mp interaction for a substantial remote decision, or the normal chat question when local.`,
    },
  }) + '\n')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
