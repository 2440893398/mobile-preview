import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function stateDir() {
  return process.env.MP_STATE_DIR
    || join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), 'mobile-preview')
}

export function statePath() {
  return join(stateDir(), 'state.json')
}

export function tunnelLogPath() {
  return join(stateDir(), 'cloudflared.log')
}

export function read() {
  const f = statePath()
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

export function write(patch) {
  mkdirSync(stateDir(), { recursive: true })
  const next = { ...(read() || {}), ...patch }
  writeFileSync(statePath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function clear() {
  const f = statePath()
  if (existsSync(f)) rmSync(f, { force: true })
}
