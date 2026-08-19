// The plugin ships separately from the CLI, so this script has to work both
// ways round: when the CLI is reachable it reuses the CLI's own checks (one
// source of truth, no drift), and when it is not — which is itself the most
// common finding — it says exactly that, with the command that fixes it.
//
// It used to report a bare `missing: mp.cmd` for every one of those cases,
// which sent people off reinstalling cloudflared when all they needed was
// `npm link`.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WIN = process.platform === 'win32'
const MP_COMMAND = WIN ? 'mp.cmd' : 'mp'

function resolveCommand(name) {
  try {
    const out = execFileSync(WIN ? 'where.exe' : 'which', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
    return out.split(/\r?\n/).find(Boolean)?.trim() || null
  } catch {
    return null
  }
}

// Keep this lookup in lockstep with src/tunnel.js. cloudflared is routinely
// installed somewhere that is not on PATH — a check that only asks PATH
// reports it missing while `mp start` uses it happily, and that contradiction
// has already cost a debugging session.
function resolveCloudflared() {
  const fromPath = resolveCommand('cloudflared')
  if (fromPath) return fromPath

  const candidates = [
    `${process.env.LOCALAPPDATA || ''}\\Microsoft\\WinGet\\Links\\cloudflared.exe`,
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null
}

function globalNpmRoot() {
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

// Three ways in, cheapest first.
//
// The bare `import('mobile-preview/doctor')` on its own is not enough and was
// the bug here: Node does not search the *global* node_modules for bare
// specifiers, so a perfectly good `npm link` still failed to resolve and every
// run silently fell through to the degraded path — which then reported an
// installed cloudflared as missing. Ask npm where global packages live and
// import by absolute path instead.
async function loadDoctor() {
  const inCheckout = new URL('../../../src/doctor.js', import.meta.url)
  if (existsSync(inCheckout)) {
    try {
      return await import(inCheckout.href)
    } catch {
      // fall through
    }
  }

  try {
    return await import('mobile-preview/doctor')
  } catch {
    // fall through
  }

  const root = globalNpmRoot()
  const linked = root ? join(root, 'mobile-preview', 'src', 'doctor.js') : null
  if (linked && existsSync(linked)) {
    try {
      return await import(pathToFileURL(linked).href)
    } catch {
      // fall through
    }
  }

  return null
}

const doctor = await loadDoctor()

if (doctor) {
  const checks = doctor.runChecks()
  console.log(doctor.formatDoctor(checks))
  console.log('')
  console.log(doctor.LOCALHOST_HARDCODE_HINT)
  if (checks.some((c) => !c.ok && !c.optional)) process.exitCode = 1
} else {
  // No reachable CLI. Report that as the specific, actionable thing it is, and
  // still check the external tools so one run tells the whole story.
  const onPath = resolveCommand(MP_COMMAND)
  console.log(onPath
    ? `MISSING  mobile-preview: ${MP_COMMAND} is on PATH at ${onPath}, but its package could not be imported`
    : `MISSING  mobile-preview: ${MP_COMMAND} is not installed`)
  console.log('         fix: run `npm install && npm link` inside the mobile-preview checkout')

  const cloudflared = resolveCloudflared()
  console.log(cloudflared
    ? `ok       cloudflared: ${cloudflared}`
    : 'MISSING  cloudflared\n         fix: winget install --id Cloudflare.cloudflared')

  const ffmpeg = resolveCommand('ffmpeg')
  console.log(ffmpeg
    ? `ok       ffmpeg: ${ffmpeg}`
    : 'optional ffmpeg: not found — only `mp capture --video` needs it')

  if (WIN) {
    console.log('')
    console.log('On Windows PowerShell, `mp` resolves to the Move-ItemProperty alias — call `mp.cmd`.')
  }

  process.exitCode = 1
}
