import {
  readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, existsSync, readdirSync, statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

function stateDir() {
  return process.env.MP_STATE_DIR
    || join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), 'mobile-preview')
}

export function previewsDir() {
  return join(stateDir(), 'previews')
}

// The pre-multi-slot single global slot. Kept only so cleanup can find and
// kill whatever an older version left running.
export function legacyStatePath() {
  return join(stateDir(), 'state.json')
}

export function statePath(port) {
  return join(previewsDir(), `${port}.json`)
}

export function tunnelLogPath(port) {
  return join(previewsDir(), `${port}.cloudflared.log`)
}

export function galleryDir(port) {
  return join(stateDir(), 'gallery', String(port))
}

// ---- secret slots ----
//
// One file per `mp secret ask`, keyed by a short random id rather than a port:
// a secret slot has no port of its own to be keyed by, and two asks in one
// session must not collide. The file never holds a value — only names,
// fingerprints, approved uses and the pids that own them. See the 2026-09-11
// secret-relay design, §4.4.

export const SECRET_ID_RE = /^s-[a-z0-9]{4,12}$/

export function secretsDir() {
  return join(stateDir(), 'secrets')
}

export function secretStatePath(id) {
  return join(secretsDir(), `${id}.json`)
}

export function secretLogPath(id) {
  return join(secretsDir(), `${id}.log`)
}

export function secretTunnelLogPath(id) {
  return join(secretsDir(), `${id}.cloudflared.log`)
}

// Where the daemon that holds the values listens for `mp secret run`. A named
// pipe on Windows, a unix socket elsewhere; either way it is reachable only
// from this machine, and the protocol it speaks has no operation that returns
// a value (design §4.5).
export function secretIpcPath(id) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\mp-secret-${id}`
  return join(secretsDir(), `${id}.sock`)
}

// ---- interaction slots ----
//
// One file per `mp interaction ask`, keyed like a secret slot and for the same
// reason: a question has no port of its own, and two open at once must not
// collide. Unlike a secret slot this file does hold the payload — the answer
// is the whole point, and it has to outlive the process that collected it so a
// late `wait` still finds it.

export const INTERACTION_ID_RE = /^i-[a-z0-9]{4,12}$/

export function interactionsDir() {
  return join(stateDir(), 'interactions')
}

export function interactionStatePath(id) {
  return join(interactionsDir(), `${id}.json`)
}

// Where `ask` stages the page for the daemon to pick up. Never a long-lived
// file: the daemon reads it once and deletes it.
export function interactionPagePath(id) {
  return join(interactionsDir(), `${id}.page.html`)
}

export function interactionLogPath(id) {
  return join(interactionsDir(), `${id}.log`)
}

export function interactionTunnelLogPath(id) {
  return join(interactionsDir(), `${id}.cloudflared.log`)
}

export function interactionIpcPath(id) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\mp-interaction-${id}`
  return join(interactionsDir(), `${id}.sock`)
}

// Distinguishes "no file" from "a file that will not parse" — read() alone
// collapses both to null, which is exactly what let `mp start` double-spawn
// over a truncated slot (Gap 1): it saw null, concluded there was nothing to
// clean up, and started a second daemon into a slot that may already have
// one. Callers that must react differently to the two (cmdStart) use this;
// callers that only ever needed "is there something here I can use" keep
// using read().
function readStateAt(f) {
  if (!existsSync(f)) return { status: 'missing', value: null }
  try {
    return { status: 'ok', value: JSON.parse(readFileSync(f, 'utf8')) }
  } catch {
    return { status: 'corrupt', value: null }
  }
}

export function readState(port) {
  return readStateAt(statePath(port))
}

export function read(port) {
  return readState(port).value
}

export function readSecretState(id) {
  return readStateAt(secretStatePath(id))
}

export function readSecret(id) {
  return readSecretState(id).value
}

export function readInteractionState(id) {
  return readStateAt(interactionStatePath(id))
}

export function readInteraction(id) {
  return readInteractionState(id).value
}

const LOCK_RETRY_MS = 20
// How long a single write() will retry before giving up and reporting the
// slot as stuck, rather than hanging a command forever.
const LOCK_TIMEOUT_MS = 20_000
// A lock this old is presumed abandoned by a process that died mid-write
// (crash, taskkill, power loss) rather than one merely slow to finish —
// otherwise a single dead process wedges every future write to that port's
// slot forever. Set below LOCK_TIMEOUT_MS so a waiter's own timeout always
// gives the staleness check a chance to fire and self-heal first.
const LOCK_STALE_MS = 10_000

// A synchronous sleep. write() has no async story anywhere it is called —
// the proxy's onWindowOpen callback and `mp capture` both call it as a plain,
// non-awaited function — so the lock wait has to block in kind rather than
// return a promise only some callers could use.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// The one thing every process agrees on atomically: O_EXCL creation either
// succeeds or fails, with no window in between where two callers could both
// believe they hold it. That, not any timing, is what serializes writers.
function acquireLock(file, label) {
  const lockPath = `${file}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
      return lockPath
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }

    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true })
        continue
      }
    } catch {
      // Vanished between the failed create and this stat — its holder just
      // released it. Loop back and try to acquire straight away.
      continue
    }

    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for the state lock on ${label} (${lockPath}). `
        + 'Another process may have died while holding it — delete the file if so.',
      )
    }

    sleepSync(LOCK_RETRY_MS)
  }
}

// Atomic on purpose. `write` runs on every `mp capture`, not just at startup,
// and a plain writeFileSync interrupted mid-write leaves truncated JSON —
// which read() reports as null, list() skips, and cleanup therefore never
// sweeps, leaving a live cloudflared orphaned with no way to find it. Writing
// beside the target and renaming over it means a reader sees the whole old
// file or the whole new one, never half of one. The temp name carries the pid
// so two writers cannot collide on it.
//
// Cross-process-safe on purpose too. Two writers doing read-modify-write at
// once — the daemon's onWindowOpen and `mp capture` appending an artifact are
// exactly this shape — can each read before the other has renamed; without a
// lock, whichever renames last wins outright and the other's field is gone
// with no error, no warning, nothing torn for read() to catch. The rename
// alone only rules out a half-written file, not a fully-written one that
// silently overwrote a sibling's change.
//
// The lock protects *different* fields merged from concurrent writers. A
// patch computed from a read taken before the lock still loses same-field
// updates — appending to `artifacts` is exactly that shape — so `patch` may
// be a function: it runs inside the lock, on the freshly re-read state, and
// returns the fields to merge.
//
// Refuses to write over a corrupt slot rather than resurrecting it: merging
// over `read() || {}` would quietly turn unparseable JSON — pids and all —
// into a fresh record containing only this patch.
function writeAt(f, patch, { label, corruptHint }) {
  mkdirSync(dirname(f), { recursive: true })
  const lockPath = acquireLock(f, label)

  try {
    const { status, value } = readStateAt(f)
    if (status === 'corrupt') {
      throw new Error(
        `${label} is corrupt (${f}); refusing to overwrite it. ${corruptHint}`,
      )
    }
    const base = value || {}
    const next = { ...base, ...(typeof patch === 'function' ? patch(base) : patch) }
    const tmp = `${f}.${process.pid}.tmp`

    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
      renameSync(tmp, f)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }

    return next
  } finally {
    rmSync(lockPath, { force: true })
  }
}

export function write(port, patch) {
  return writeAt(statePath(port), patch, {
    label: `preview state for port ${port}`,
    corruptHint: 'Run `mp stop --all` or delete the file.',
  })
}

export function writeSecret(id, patch) {
  return writeAt(secretStatePath(id), patch, {
    label: `secret state for ${id}`,
    corruptHint: 'Run `mp secret forget --all` or delete the file.',
  })
}

export function writeInteraction(id, patch) {
  return writeAt(interactionStatePath(id), patch, {
    label: `interaction state for ${id}`,
    corruptHint: 'Run `mp interaction close --all` or delete the file.',
  })
}

export function clear(port) {
  const f = statePath(port)
  if (existsSync(f)) rmSync(f, { force: true })
}

export function clearSecret(id) {
  const f = secretStatePath(id)
  if (existsSync(f)) rmSync(f, { force: true })
}

export function clearInteraction(id) {
  for (const f of [interactionStatePath(id), interactionPagePath(id)]) {
    if (existsSync(f)) rmSync(f, { force: true })
  }
}

// Same contract as list(): never throws, skips what will not parse, and the
// filename is the id of record.
export function listSecrets() {
  const dir = secretsDir()
  if (!existsSync(dir)) return []

  const out = []
  for (const name of readdirSync(dir)) {
    const m = /^(s-[a-z0-9]+)\.json$/.exec(name)
    if (!m || !SECRET_ID_RE.test(m[1])) continue
    const s = readSecret(m[1])
    if (!s) continue
    out.push({ ...s, id: m[1] })
  }

  return out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
}

// Same contract as listSecrets(): never throws, skips what will not parse.
export function listInteractions() {
  const dir = interactionsDir()
  if (!existsSync(dir)) return []

  const out = []
  for (const name of readdirSync(dir)) {
    const m = /^(i-[a-z0-9]+)\.json$/.exec(name)
    if (!m || !INTERACTION_ID_RE.test(m[1])) continue
    const s = readInteraction(m[1])
    if (!s) continue
    out.push({ ...s, id: m[1] })
  }

  return out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
}

// Never throws: status is the last thing a user has when everything else has
// gone wrong, so a single corrupt file must not take the listing down.
export function list() {
  const dir = previewsDir()
  if (!existsSync(dir)) return []

  const out = []
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(name)
    if (!m) continue
    const s = read(m[1])
    if (!s) continue
    // The filename is the key of record — a targetPort inside the file that
    // disagrees with it is stale data.
    out.push({ ...s, targetPort: Number(m[1]) })
  }

  return out.sort((a, b) => a.targetPort - b.targetPort)
}
