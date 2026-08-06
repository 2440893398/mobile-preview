import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
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

export function read(port) {
  const f = statePath(port)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

export function write(port, patch) {
  mkdirSync(previewsDir(), { recursive: true })
  const next = { ...(read(port) || {}), ...patch }
  writeFileSync(statePath(port), JSON.stringify(next, null, 2), 'utf8')
  return next
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
