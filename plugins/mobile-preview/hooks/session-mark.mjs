import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

// What the triggers share: one note per session, initialized by SessionStart
// and updated when the user confirms whether this session is remote.
//
// The note exists because detection is not free. Working out whether the
// person is on a phone costs a process-tree walk on the host that cannot
// answer from its environment, and about a second of PowerShell on Windows.
// SessionStart pays that once; a hook that fires on every turn must not pay
// it at all. No note means we have not established a remote mode yet.
//
// Deliberately duplicated rather than imported from src/state.js: when this
// plugin is installed on its own, that file is not there.

const MAX_AGE_MS = 24 * 60 * 60_000
// A confirmed choice is refreshed on user prompts, so a task used over many
// days keeps it. Abandoned tasks expire after a month rather than forever.
const MANUAL_MAX_AGE_MS = 30 * MAX_AGE_MS

function isFresh(mark) {
  const maxAge = typeof mark?.manualRemote === 'boolean' ? MANUAL_MAX_AGE_MS : MAX_AGE_MS
  return Boolean(mark?.at) && Date.now() - mark.at <= maxAge
}

export function stateDir(env = process.env) {
  return env.MP_STATE_DIR
    || join(env.LOCALAPPDATA || env.HOME || process.cwd(), 'mobile-preview')
}

export function sessionsDir(env = process.env) {
  return join(stateDir(env), 'sessions')
}

// Session ids come from the host and land in a filename, so anything that is
// not plainly an id is refused rather than sanitised — a hook is the wrong
// place to be creative about paths.
function markPath(sessionId, env) {
  const id = String(sessionId ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes('..')) return null
  return join(sessionsDir(env), `${id}.json`)
}

export function readMark(sessionId, env = process.env) {
  const f = markPath(sessionId, env)
  if (!f || !existsSync(f)) return null
  try {
    const mark = JSON.parse(readFileSync(f, 'utf8'))
    if (!isFresh(mark)) return null
    return mark
  } catch {
    return null
  }
}

export function writeMark(sessionId, patch, env = process.env) {
  const f = markPath(sessionId, env)
  if (!f) return null
  const next = { ...(readMark(sessionId, env) ?? {}), ...patch, at: Date.now() }
  try {
    mkdirSync(sessionsDir(env), { recursive: true })
    writeFileSync(f, JSON.stringify(next), 'utf8')
  } catch {
    // A session that cannot be marked behaves like one that was never
    // marked: the later hooks stay silent. That is the failure this is
    // allowed to have.
    return null
  }
  return next
}

// Sessions end without telling anyone, so nothing would ever delete these.
// Pruning on write keeps the directory from growing for the life of the
// machine, and costs one readdir on a directory with a handful of entries.
export function pruneMarks(env = process.env) {
  const dir = sessionsDir(env)
  if (!existsSync(dir)) return 0
  let gone = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const f = join(dir, name)
      try {
        const mark = JSON.parse(readFileSync(f, 'utf8'))
        if (isFresh(mark)) continue
      } catch {
        // Unreadable is as good as expired.
      }
      rmSync(f, { force: true })
      gone += 1
    }
  } catch {
    return gone
  }
  return gone
}

// Whether a question is already in front of the user. The Stop hook uses this
// to tell "the model wrote out a decision instead of opening a page" from
// "the model opened a page and is describing it", which look alike in the
// message text and are opposites.
// A record that has been answered is not a question in front of anyone — and
// it outlives the answer by its whole TTL, two hours by default. Counting
// those would mean one finished question silences this hook for the rest of
// the afternoon, and on Codex this is the only trigger there is.
export function hasOpenInteraction(env = process.env) {
  const dir = join(stateDir(env), 'interactions')
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).filter((name) => /^i-[a-z0-9]+\.json$/.test(name)).some((name) => {
      try {
        const s = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (s?.response) return false
        if (s?.expiresAt && Date.now() > s.expiresAt) return false
        return s?.stage === 'starting' || s?.stage === 'collecting'
      } catch {
        // Unreadable says nothing either way, and silence is this hook's safe
        // direction.
        return false
      }
    })
  } catch {
    return false
  }
}

// ---- the other way a person ends up on a phone ----
//
// Happy is decided once, at SessionStart, because a Happy session is a phone
// session from its first line to its last. The Claude desktop app's own
// remote is not: the same session is typed into at the desk, then from the
// phone on the way out, then at the desk again. So this is asked per turn.
//
// Nothing the session itself can see tells the two apart. The environment is
// the same, the transcript records a phone message exactly like a desk one,
// and the hook payload carries no origin (checked 2026-09-24, desktop app
// 2.7032). The one thing that flips per message is `steeredByRemoteClient` in
// the app's own metadata for the session — true after a message from the
// phone, false after one from the desk.
//
// That file is written in batches, 6–25 s after the message. So this is read
// late in a turn — at Stop, and when a question is about to be asked — and
// never at UserPromptSubmit, where it still describes the previous message.
// A short turn can still see the previous value. Both ways that goes wrong are
// cheap: a desk user gets a tunnel link that also works locally, or a phone
// user's short turn goes unchecked — and a short turn is not a wall of text.

function desktopAppDir(env) {
  if (env.MP_CLAUDE_DESKTOP_DIR) return env.MP_CLAUDE_DESKTOP_DIR
  if (env.APPDATA) return join(env.APPDATA, 'Claude')
  if (env.HOME) return join(env.HOME, 'Library', 'Application Support', 'Claude')
  return null
}

// <app>/claude-code-sessions/<account>/<org>/<host session id>.json. The id
// comes from the environment, so it is checked before it becomes a filename.
export function desktopSessionFile(env = process.env) {
  const id = String(env.CLAUDE_CODE_HOST_SESSION_ID ?? '')
  if (!/^local_[A-Za-z0-9_-]{1,120}$/.test(id)) return null
  const app = desktopAppDir(env)
  if (!app) return null
  const root = join(app, 'claude-code-sessions')
  try {
    for (const account of readdirSync(root)) {
      for (const org of readdirSync(join(root, account))) {
        const f = join(root, account, org, `${id}.json`)
        if (existsSync(f)) return f
      }
    }
  } catch {
    // Not the desktop app, or a layout this does not know: not remote.
  }
  return null
}

export function desktopSteeringStatus(env = process.env) {
  const f = desktopSessionFile(env)
  if (!f) return null
  try {
    const value = JSON.parse(readFileSync(f, 'utf8'))?.steeredByRemoteClient
    return typeof value === 'boolean' ? value : null
  } catch {
    return null
  }
}

export function steeredFromPhone(env = process.env) {
  return desktopSteeringStatus(env) === true
}

// How many times the hooks may ask "远端 or 本机?" in one session before they
// stop asking. A user who does not answer the exact word twice is not going
// to on the third try, and asking every turn is the nuisance these hooks exist
// to avoid.
export const MAX_CONFIRM_ASKS = 2

// A human can confirm the mode once for this session when Codex cannot tell
// who sent a message. Explicit local confirmation silences the question, but
// never overrides a live Happy or Claude phone signal.
//
// `local` is only true when something positively said "at this computer" —
// the desktop app's per-message flag or the user's own answer. Giving up on
// the question counts as confirmed (stop asking) but not as local.
export function remoteStatus(mark, env = process.env) {
  if (mark?.remote) return { remote: true, confirmed: true, local: false }
  // Claude desktop reports both directions per message. A stale manual choice
  // must not keep it remote after that host reports a local message.
  const desktop = desktopSteeringStatus(env)
  if (desktop !== null) return { remote: desktop, confirmed: true, local: !desktop }
  if (typeof mark?.manualRemote === 'boolean') {
    return { remote: mark.manualRemote, confirmed: true, local: !mark.manualRemote }
  }
  const gaveUp = Number(mark?.confirmAsks ?? 0) >= MAX_CONFIRM_ASKS
  return { remote: false, confirmed: gaveUp, local: false }
}

export function recordConfirmAsk(sessionId, mark, env = process.env) {
  return writeMark(sessionId, {
    awaitingManualRemote: true,
    confirmAsks: Number(mark?.confirmAsks ?? 0) + 1,
  }, env)
}

// Shared by the PreToolUse and Stop hooks. The session id goes into the
// fallback command: outside Codex nothing in the shell environment names the
// session, so a bare `mp remote on` has nothing to key the choice by.
export function confirmReason(sessionId, lead) {
  const session = markPath(sessionId, process.env) ? ` --session ${sessionId}` : ''
  return `${lead} Before presenting it, ask one short question in chat: `
    + '"Are you using this session from a phone or other remote device? Reply 远端 or 本机." '
    + 'End the turn after asking; do not use an asynchronous question tool, so the answer starts a new turn. '
    + 'The UserPromptSubmit hook remembers either exact reply for this session. If it does not, '
    + `run \`mp remote on${session}\` for 远端 or \`mp remote off${session}\` for 本机. `
    + 'Then present the decision: use `mp interaction ask` if remote, or the normal chat question if local. '
    + 'Do not infer the device from this prompt.'
}

export function isRemoteNow(mark, env = process.env) {
  return remoteStatus(mark, env).remote
}
