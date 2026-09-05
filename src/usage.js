import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// package.json is the single version of record. The plugin manifest, the README
// and the skill used to each carry a number of their own, which drifted: users
// were handed 0.1.1 docs describing a 0.1.0 binary. tests/usage.test.js asserts
// the others still agree with this one, so the drift cannot come back quietly.
export const VERSION = JSON.parse(
  readFileSync(join(HERE, '..', 'package.json'), 'utf8'),
).version

export const TAGLINE = 'temporary authenticated preview of a local app, for phone-based AI workflows'

// The single source of truth for what the parser accepts and what --help says.
// Two lists that must agree always end up disagreeing, so there is only one:
// parseArgs rejects anything absent from `flags`, and renderHelp prints exactly
// what is present in it.
export const COMMANDS = {
  start: {
    summary: 'Expose the local app on a temporary authenticated public url',
    args: '',
    maxPositionals: 0,
    flags: {
      port: { value: '<n>', default: '5173', help: 'Local port to expose — the port your app already listens on' },
      ttl: { value: '<min>', default: '30', help: 'Minutes before the preview self-terminates (1–1440)' },
      grace: { value: '<min>', default: 'the --ttl value, i.e. reusable until expiry', help: 'Minutes the link stays exchangeable after its first use (0 = one-shot)' },
      dev: { help: 'Expose a dev server rather than a build (larger attack surface)' },
      json: { help: 'Print one machine-readable JSON object on stdout instead of prose' },
    },
  },
  capture: {
    summary: 'Screenshot the app at phone size and report what went wrong on the page',
    args: '[url]',
    maxPositionals: 1,
    flags: {
      port: { value: '<n>', help: 'Which preview to capture through (default: the only active one)' },
      device: { value: '<name>', default: 'iPhone 13', help: 'Playwright device profile, e.g. "Pixel 7", "iPhone 15 Pro"' },
      steps: { value: '<file>', help: 'ESM file default-exporting async (page) => {}, run before the screenshot' },
      video: { help: 'Record the session as an MP4 (requires ffmpeg on PATH)' },
      'wait-for': { value: '<selector>', help: 'Wait until this CSS selector is visible before shooting' },
      'wait-ms': { value: '<n>', default: '500', help: 'Extra milliseconds to wait after the page settles' },
      'network-idle': { help: 'Wait for the network to fall idle, not just for load — for API-driven SPAs' },
      'full-page': { help: 'Capture the whole scrollable page, not just the first screen' },
      strict: { help: 'Exit non-zero when the page had console errors or failed requests' },
    },
  },
  status: {
    summary: 'List active previews and how long each has left',
    args: '',
    maxPositionals: 0,
    flags: {
      json: { help: 'Print a machine-readable JSON array on stdout instead of prose' },
    },
  },
  stop: {
    summary: 'Tear a preview down and make sure nothing is left running',
    args: '',
    maxPositionals: 0,
    flags: {
      port: { value: '<n>', help: 'Which preview to stop (default: the only active one)' },
      all: { help: 'Stop every preview, including stale and unreadable slots' },
    },
  },
  doctor: {
    summary: 'Check that everything mp needs is installed, on PATH and reachable',
    args: '',
    maxPositionals: 0,
    flags: {
      json: { help: 'Print a machine-readable JSON array on stdout instead of prose' },
    },
  },
}

export function isValueFlag(spec, name) {
  return Boolean(spec?.flags?.[name]?.value)
}

function flagSyntax(name, def) {
  return def.value ? `--${name} ${def.value}` : `--${name}`
}

function renderFlags(flags) {
  const names = Object.keys(flags)
  if (names.length === 0) return []

  const width = Math.max(...names.map((n) => flagSyntax(n, flags[n]).length))
  return names.map((n) => {
    const def = flags[n]
    const tail = def.default === undefined ? def.help : `${def.help} (default ${def.default})`
    return `  ${flagSyntax(n, def).padEnd(width)}  ${tail}`
  })
}

export function renderCommandHelp(name) {
  const spec = COMMANDS[name]
  if (!spec) return null

  const usage = ['mp', name, spec.args, '[options]'].filter(Boolean).join(' ')
  // --help is accepted by every command, so it is rendered with the rest
  // rather than bolted on underneath as a second, differently-formatted list.
  const flags = { ...spec.flags, help: { help: 'Show this help' } }

  return [
    `mp ${name} — ${spec.summary}`,
    '',
    `usage: ${usage}`,
    '',
    'options:',
    ...renderFlags(flags),
  ].join('\n')
}

export function renderHelp() {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length))
  const commands = Object.entries(COMMANDS)
    .map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`)

  return [
    `mp — ${TAGLINE}`,
    '',
    'usage: mp <command> [options]',
    '',
    'commands:',
    ...commands,
    '',
    'global options:',
    '  -h, --help     Show this help, or `mp <command> --help` for one command',
    '  -v, --version  Print the mp version',
    '',
    'On Windows PowerShell, `mp` collides with the built-in Move-ItemProperty',
    'alias — call `mp.cmd` there. `mp doctor` checks the rest of the setup.',
  ].join('\n')
}
