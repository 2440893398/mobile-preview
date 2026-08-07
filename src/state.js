import {
  readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, existsSync, readdirSync, statSync,
} from 'node:fs'
import { join } from 'node:path'

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

// Distinguishes "no file" from "a file that will not parse" — read() alone
// collapses both to null, which is exactly what let `mp start` double-spawn
// over a truncated slot (Gap 1): it saw null, concluded there was nothing to
// clean up, and started a second daemon into a slot that may already have
// one. Callers that must react differently to the two (cmdStart) use this;
// callers that only ever needed "is there something here I can use" keep
// using read().
export function readState(port) {
  const f = statePath(port)
  if (!existsSync(f)) return { status: 'missing', value: null }
  try {
    return { status: 'ok', value: JSON.parse(readFileSync(f, 'utf8')) }
  } catch {
    return { status: 'corrupt', value: null }
  }
}

export function read(port) {
  return readState(port).value
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
function acquireLock(port) {
  const lockPath = `${statePath(port)}.lock`
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
        `timed out waiting for the state lock on port ${port} (${lockPath}). `
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
export function write(port, patch) {
  mkdirSync(previewsDir(), { recursive: true })
  const lockPath = acquireLock(port)

  try {
    const next = { ...(read(port) || {}), ...patch }
    const f = statePath(port)
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

export function clear(port) {
  const f = statePath(port)
  if (existsSync(f)) rmSync(f, { force: true })
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
