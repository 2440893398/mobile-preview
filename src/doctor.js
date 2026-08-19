import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findBrowserExecutable, findPlaywrightChromium, playwrightBrowsersDir } from './browser.js'
import { WIN, findCloudflared, resolveCommand } from './locate.js'

export { resolveCommand }

export const MP_COMMAND = WIN ? 'mp.cmd' : 'mp'

// Where npm would have put a globally linked package. Used only to tell
// "never installed" apart from "installed, but this shell cannot see it" —
// historically reported as the same bare `missing: mp.cmd`, which sent people
// off reinstalling cloudflared when all they needed was `npm link`.
export function globalNpmRoot() {
  try {
    const out = execFileSync(WIN ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      shell: WIN,
    })
    return out.trim() || null
  } catch {
    return null
  }
}

// Kept as a named export (package.json exposes ./doctor); the actual probe
// lives in locate.js, shared with tunnel.js.
export function findCloudflaredBinary() {
  return findCloudflared()
}

function cliCheck(probes) {
  const onPath = probes.resolveCommand(MP_COMMAND)
  if (onPath) {
    return {
      id: 'cli', label: MP_COMMAND, ok: true, optional: false, detail: onPath,
    }
  }

  const root = probes.globalNpmRoot()
  const linked = root ? join(root, 'mobile-preview') : null
  if (linked && probes.exists(linked)) {
    return {
      id: 'cli',
      label: MP_COMMAND,
      ok: false,
      optional: false,
      detail: `linked at ${linked}, but ${MP_COMMAND} is not resolvable on PATH`,
      fix: WIN
        ? 'Open a new shell (PATH is captured at launch). If it still fails, add the directory printed by `npm prefix -g` to PATH.'
        : 'Open a new shell, or add the directory printed by `npm prefix -g`/bin to PATH.',
    }
  }

  return {
    id: 'cli',
    label: MP_COMMAND,
    ok: false,
    optional: false,
    detail: 'not installed globally',
    fix: 'Run `npm link` inside the mobile-preview checkout (after `npm install`).',
  }
}

function cloudflaredCheck(probes) {
  const bin = probes.findCloudflared()
  return {
    id: 'cloudflared',
    label: 'cloudflared',
    ok: Boolean(bin),
    optional: false,
    detail: bin || 'not found on PATH or in the usual install locations',
    fix: 'winget install --id Cloudflare.cloudflared  (or download from https://github.com/cloudflare/cloudflared/releases)',
  }
}

function chromiumCheck(probes) {
  const installed = probes.findPlaywrightChromium()
  if (installed) {
    return {
      id: 'chromium', label: 'Playwright Chromium', ok: true, optional: false, detail: installed,
    }
  }

  // capture.js falls back to a system Chrome/Edge, so a machine without the
  // playwright download can still screenshot. Report that honestly instead of
  // sending the user to re-download 150 MB they do not need.
  const fallback = probes.findBrowserExecutable()
  if (fallback) {
    return {
      id: 'chromium',
      label: 'Playwright Chromium',
      ok: true,
      optional: false,
      detail: `not downloaded; capture will fall back to ${fallback}`,
    }
  }

  return {
    id: 'chromium',
    label: 'Playwright Chromium',
    ok: false,
    optional: false,
    detail: `no browser in ${probes.browsersDir()} and no system Chrome/Edge — mp capture cannot run`,
    fix: 'npx playwright install chromium',
  }
}

function ffmpegCheck(probes) {
  const bin = probes.resolveCommand('ffmpeg')
  return {
    id: 'ffmpeg',
    label: 'ffmpeg',
    ok: Boolean(bin),
    optional: true,
    detail: bin || 'not found — only `mp capture --video` needs it, everything else works',
    fix: WIN
      ? 'winget install --id Gyan.FFmpeg  (then open a new shell)'
      : 'Install ffmpeg with your package manager, e.g. `brew install ffmpeg` or `apt install ffmpeg`.',
  }
}

const DEFAULT_PROBES = {
  resolveCommand,
  globalNpmRoot,
  findCloudflared: findCloudflaredBinary,
  findPlaywrightChromium,
  findBrowserExecutable,
  browsersDir: playwrightBrowsersDir,
  exists: existsSync,
}

// Every probe is injectable so the classification logic — the part that has
// actually been wrong in the field — is testable without a particular machine's
// software installed.
export function runChecks(overrides = {}) {
  const probes = { ...DEFAULT_PROBES, ...overrides }
  return [
    cliCheck(probes),
    cloudflaredCheck(probes),
    chromiumCheck(probes),
    ffmpegCheck(probes),
  ]
}

export function formatDoctor(checks, { win = WIN } = {}) {
  const lines = []

  for (const c of checks) {
    const status = c.ok ? 'ok' : c.optional ? 'optional' : 'MISSING'
    lines.push(`${status.padEnd(8)} ${c.label}: ${c.detail}`)
    if (!c.ok && c.fix) lines.push(`         fix: ${c.fix}`)
  }

  const blocking = checks.filter((c) => !c.ok && !c.optional)
  lines.push('')
  lines.push(blocking.length === 0
    ? 'Everything mp needs is present.'
    : `${blocking.length} required item(s) missing — mp cannot run until they are fixed.`)

  if (win) {
    lines.push('')
    lines.push('On Windows PowerShell, `mp` resolves to the Move-ItemProperty alias.')
    lines.push('Call `mp.cmd` there, or `& mp` in a shell where the alias is removed.')
    lines.push('If your phone cannot reach a preview whose url printed fine, the tunnel')
    lines.push('registered late or not at all — see the cloudflared log named by `mp status`.')
  }

  return lines.join('\n')
}

// A page that hardcodes http://127.0.0.1:<port> resolves to the *phone* once
// the html is opened there, which looks like a dead backend and is reported as
// a mobile-preview bug. Checked as advice, not as a failure: plenty of apps use
// relative urls and never hit this.
export const LOCALHOST_HARDCODE_HINT = 'If the page loads but its API calls fail on the phone, check for a hardcoded '
  + 'http://127.0.0.1 or http://localhost base url — on the phone that resolves to the phone. '
  + 'Use a relative /api path so it travels through the tunnel.'
