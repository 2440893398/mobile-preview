import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

// What the three triggers share: one note per session, written once by
// SessionStart, read by the two hooks that fire afterwards.
//
// The note exists because detection is not free. Working out whether the
// person is on a phone costs a process-tree walk on the host that cannot
// answer from its environment, and about a second of PowerShell on Windows.
// SessionStart pays that once; a hook that fires on every turn must not pay
// it at all. No note means "not a phone session, or we never found out", and
// both of those mean the same thing here: stay quiet.
//
// Deliberately duplicated rather than imported from src/state.js: when this
// plugin is installed on its own, that file is not there.

const MAX_AGE_MS = 24 * 60 * 60_000

function stateDir(env = process.env) {
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
    if (!mark?.at || Date.now() - mark.at > MAX_AGE_MS) return null
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
        if (mark?.at && Date.now() - mark.at <= MAX_AGE_MS) continue
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
