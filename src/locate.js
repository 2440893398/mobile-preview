import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'

// The one place that knows how to find an executable. tunnel.js, doctor.js
// and capture.js each used to carry their own copy of the `where`/`which`
// probe — and tunnel.js and doctor.js each their own list of cloudflared
// install locations. Two lists that must agree always end up disagreeing;
// now there is one of each.

export const WIN = platform() === 'win32'

export function resolveCommand(name) {
  const locator = WIN ? 'where' : 'which'
  try {
    const out = execFileSync(locator, [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    })
    return out.split(/\r?\n/).find(Boolean)?.trim() || null
  } catch {
    return null
  }
}

// Common WinGet/MSI locations, tried when PATH does not resolve — a shell
// opened before the install happened has the stale PATH but the files exist.
const CLOUDFLARED_CANDIDATES = () => [
  `${process.env.LOCALAPPDATA || ''}\\Microsoft\\WinGet\\Links\\cloudflared.exe`,
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
]

export function findCloudflared() {
  const fromPath = resolveCommand('cloudflared')
  if (fromPath) return fromPath
  if (!WIN) return null

  return CLOUDFLARED_CANDIDATES().find((candidate) => candidate && existsSync(candidate)) || null
}
