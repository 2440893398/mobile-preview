// A skill only fires when the model thinks of it, and the model thinks of it
// from the words the user typed. Someone holding a phone does not type "use the
// mobile-preview plugin" — they type "show me how it looks now", and get back a
// http://localhost:5173 that on their device points at the phone itself.
//
// This hook does not try to guess what the user wants. It answers the one
// question that can be answered without guessing: is the person on the other end
// still sitting at this machine? A Happy session is a phone session by
// construction, so in one of those, a local address is never a deliverable.
//
// Detection deliberately does not scan the environment for the substring
// "happy": a machine that uses Happy at all has it in NO_PROXY and in PATH, so
// that test reports every local terminal session as remote too.
//
// The same file serves Claude Code and Codex: both discover
// <plugin>/hooks/hooks.json, both substitute ${CLAUDE_PLUGIN_ROOT}, and both
// read back the same {hookSpecificOutput: {hookEventName, additionalContext}}.
// Only the detection differs, and that is handled below.

import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readPayload } from './hook-io.mjs'
import { pruneMarks, writeMark } from './session-mark.mjs'

// Happy runs Claude Code out of its own npm package, so the SDK binary path is
// the marker that survives every launch mode we have seen. HAPPY_* variables
// only appear in some of them (a dev checkout exports HAPPY_PROJECT_ROOT, a
// plain `happy` install exports nothing), and CLAUDE_CODE_ENTRYPOINT is only
// forced to remote_mobile when the ambient environment had not already set it —
// this very session inherited `claude-desktop` and would have been missed.
const HAPPY_PACKAGE = /[\\/]node_modules[\\/](@[^\\/]+[\\/])?happy(-[a-z]+)?[\\/]/i
const HAPPY_LAUNCHER = /(^|[\\/"])happy(-cli)?(\.cmd|\.exe|\.ps1)?(\s|"|$)/i
const ANCESTOR_DEPTH = 12

function envSaysHappy(env) {
  if (HAPPY_PACKAGE.test(env.CLAUDE_CODE_EXECPATH || '')) return true
  if (Object.keys(env).some((name) => name.startsWith('HAPPY_'))) return true
  return env.CLAUDE_CODE_ENTRYPOINT === 'remote_mobile'
}

// Codex leaves no such trace. Happy drives it as `codex app-server`, spawned
// with a plain inherited environment — nothing in it says "happy", and the one
// place the name does land, the rollout file's `originator: happy-codex`, is
// written 8–25 seconds into the session, long after this hook has to answer.
// What is always true is the process tree: the session's ancestors include the
// happy CLI. Reading it costs about a second on Windows, so it only runs for
// hosts whose environment could not answer on its own.
//
// The walk stops at the first ancestor that is already gone — Windows keeps no
// record of a dead parent. Normal spawn chains (happy → codex → hook) stay
// intact; a shell that emulates exec by respawning itself, as Git Bash's
// env.exe does, can sever the chain and the session is then read as local.
function windowsAncestorQuery(pid) {
  return [
    '$t=@{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine |',
    'ForEach-Object { $t[[int]$_.ProcessId] = $_ };',
    `$id=${pid}; for($i=0; $i -lt ${ANCESTOR_DEPTH}; $i++){`,
    '$p=$t[$id]; if(-not $p){break}; Write-Output $p.CommandLine; $id=[int]$p.ParentProcessId }',
  ].join(' ')
}

function defaultRun(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  } catch {
    // A session that cannot be classified is treated as local: saying nothing
    // is the failure this hook is allowed to have.
    return ''
  }
}

// One query, and the walk itself happens inside PowerShell: asking CIM once per
// level costs ~2.7s for a chain this deep against ~0.8s for the whole table,
// and this way only our own ancestors' command lines ever leave that process.
export function ancestorCommandLines({ pid = process.pid, platform = process.platform, run = defaultRun } = {}) {
  if (platform === 'win32') {
    const args = ['-NoProfile', '-NonInteractive', '-Command', windowsAncestorQuery(pid)]
    return run('powershell.exe', args).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  }

  const table = new Map()
  for (const line of run('ps', ['-eo', 'pid=,ppid=,args=']).split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line)
    if (row) table.set(Number(row[1]), { ppid: Number(row[2]), command: row[3] })
  }

  const chain = []
  let id = pid
  for (let depth = 0; depth < ANCESTOR_DEPTH; depth++) {
    const entry = table.get(id)
    if (!entry) break
    chain.push(entry.command)
    id = entry.ppid
  }
  return chain
}

export function hasHappyAncestor(commandLines) {
  return commandLines.some((line) => HAPPY_PACKAGE.test(line) || HAPPY_LAUNCHER.test(line))
}

export function detectRemoteSession(env = process.env, options = {}) {
  if (envSaysHappy(env)) return { remote: true, via: 'env' }

  // Claude Code always exports its own executable path, so for that host the
  // check above is conclusive and no local session should pay for a scan.
  if (env.CLAUDECODE) return { remote: false, via: null }

  if (hasHappyAncestor(ancestorCommandLines(options))) return { remote: true, via: 'process-tree' }
  return { remote: false, via: null }
}

export const REMOTE_CONTEXT = `<mobile-preview>
This session was started through Happy, so the person you are answering is
almost certainly on a phone rather than at this machine. For them a
http://localhost:<port> or http://127.0.0.1:<port> address is not a link that
can be opened: on their device it resolves to the phone itself.

So, in this session:

- Never hand over a local address as the answer. Expose it first with
  \`mp start --port <port>\` (add \`--dev\` for a Vite/Webpack dev server) and
  return the preview URL it prints as a bare line of its own — not in a code
  block, which many phone clients render unselectable.
- When you need to look at the page yourself, use \`mp capture\`, rather than
  asking the user to open a browser they do not have.
- When the task needs a credential from the user — a password, an access key,
  a token, a database URL — never ask them to paste it into the chat. Run
  \`mp secret ask --purpose "<why>" --field NAME --use "<command>"\`, hand over
  the printed link the same bare way, then \`mp secret wait\` and
  \`mp secret run -- <command>\`. The CLI never prints a value and there is no
  command that does; do not go looking for one.
- When the answer you need is a choice among three or more options, two or more
  values, an ordering, or a review of more than a screen of content, do not
  write it out in the chat. Put it on a page: write one self-contained HTML
  file, run \`mp interaction ask --purpose "<why>" --html <file>\`, hand over the
  printed link the same bare way, then \`mp interaction wait --id <id>\` and act
  on the JSON it prints. A single yes/no stays in the chat.
- \`mp interaction wait\` printing status "waiting" means they are still
  reading — run it again; "expired_link" means reopen it with \`--id <id>\`.
- Load the mobile-preview skill for everything else — prerequisites, a blank
  preview, what an interaction page must contain, lifetimes and safety —
  instead of improvising around the CLI.
- If a turn has nothing to do with a local app, a credential or a decision
  only they can make, none of this applies.

In Windows PowerShell the command is \`mp.cmd\`; \`mp\` there is an alias for
Move-ItemProperty.
</mobile-preview>`

// Both hosts read hookSpecificOutput.additionalContext; a hook that stays quiet
// costs the session nothing, which is what a local session should get.
//
// The detection is also written down before it is used. The two hooks that
// fire later in the session — on a question the model is about to ask, and at
// the end of a turn — need the same answer, and neither can afford to work it
// out again: one of them runs on every single turn.
async function main() {
  // Nothing on stdin, or not JSON, leaves this null. The context below still
  // goes out either way; only the note, which needs a session id to be keyed
  // by, is skipped.
  const payload = await readPayload()

  const detected = detectRemoteSession()
  if (payload?.session_id) {
    pruneMarks()
    writeMark(payload.session_id, { remote: detected.remote, via: detected.via, blocks: 0 })
  }

  if (!detected.remote) return
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: REMOTE_CONTEXT,
    },
  }) + '\n')
}

// `file://${argv[1]}` is not the same string as import.meta.url on Windows
// (C:\… vs file:///C:/…), and getting that wrong makes the hook print nothing
// on the one platform this tool is used on most.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
