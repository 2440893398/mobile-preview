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
  // The `secret` group: credentials the phone fills in and the AI may use
  // but never read. Keyed as "secret <sub>" so parseArgs and --help treat a
  // subcommand exactly like a top-level command; main() joins the two words.
  'secret ask': {
    summary: 'Send the phone a form for credentials the AI may use but never see',
    args: '',
    maxPositionals: 0,
    flags: {
      purpose: { value: '<text>', help: 'One line shown at the top of the form: what these values are for' },
      field: { value: '<NAME[:kind]>', repeat: true, help: 'A field to collect. kind is secret (default, masked, redacted from output), text (visible, not redacted — a bucket name) or multiline (a textarea — a PEM key)' },
      use: { value: '<command>', repeat: true, help: 'A command the AI intends to run with the values, e.g. "npm run deploy"; the user ticks each one on the phone' },
      render: { value: '<TPL=OUT>', repeat: true, help: 'A config file to write from a template holding {{mp:NAME}} placeholders, for a tool that only reads its key from a file; written for one `mp secret run --render` and deleted when it exits. The user ticks each one on the phone' },
      'render-keep': { value: '<TPL=OUT>', repeat: true, help: 'Like --render, but the file stays until `mp secret forget --files`' },
      refill: { help: 'Ask for the values afresh even if they are saved for this project' },
      id: { value: '<id>', help: 'Ask an existing slot to approve more --use / --render targets instead of opening a new one; the values are not re-entered' },
      ttl: { value: '<min>', default: '120', help: 'Minutes the values stay in memory once they arrive (1–1440)' },
      'form-ttl': { value: '<min>', default: '30', help: 'Minutes the form link stays open (1–60)' },
      json: { help: 'Print one machine-readable JSON object on stdout instead of prose' },
    },
  },
  'secret wait': {
    summary: 'Block until the phone has submitted the form, then report names and fingerprints — never values',
    args: '',
    maxPositionals: 0,
    flags: {
      id: { value: '<id>', help: 'Which slot to wait on (default: the only active one)' },
      timeout: { value: '<sec>', default: '540', help: 'Seconds to wait before giving up (the link stays open regardless)' },
      json: { help: 'Print one machine-readable JSON object on stdout instead of prose' },
    },
  },
  'secret run': {
    summary: 'Run one of the approved commands with the values in its environment; output comes back redacted',
    args: '-- <command…>',
    maxPositionals: 0,
    rest: true,
    flags: {
      id: { value: '<id>', help: 'Which slot to run with (default: the only active one)' },
      cwd: { value: '<dir>', help: 'Working directory for the command (default: the current one)' },
      render: { value: '<TPL=OUT>', repeat: true, help: 'Write this approved config file before the command starts and delete it when the command exits' },
    },
  },
  'secret render': {
    summary: 'Write approved config files from their templates; deleted when the slot ends unless approved to keep',
    args: '<TPL=OUT…>',
    maxPositionals: 20,
    flags: {
      id: { value: '<id>', help: 'Which slot to render with (default: the only active one)' },
    },
  },
  'secret peek': {
    summary: 'Show a file mp rendered, with every value redacted — to check its shape, never its key',
    args: '<file>',
    maxPositionals: 1,
    flags: {
      id: { value: '<id>', help: 'Which slot rendered it (default: the only active one)' },
    },
  },
  'secret saved': {
    summary: 'List what is saved on this computer for this project: names, levels, dates, remembered uses — never values',
    args: '',
    maxPositionals: 0,
    flags: {
      all: { help: 'Every project, not only the one this directory belongs to' },
      json: { help: 'Print a machine-readable JSON array on stdout instead of prose' },
    },
  },
  'secret status': {
    summary: 'List secret slots: fields, approved uses, time left — never values',
    args: '',
    maxPositionals: 0,
    flags: {
      json: { help: 'Print a machine-readable JSON array on stdout instead of prose' },
    },
  },
  'secret forget': {
    summary: 'Wipe a slot from memory now rather than at its TTL; or delete saved values and kept files',
    args: '[NAME…]',
    maxPositionals: 50,
    flags: {
      id: { value: '<id>', help: 'Which slot to forget (default: the only active one)' },
      all: { help: 'Forget every slot, including stale ones' },
      saved: { help: 'Delete the values saved for this project instead — all of them, or only the NAMEs given' },
      files: { help: 'Delete the rendered files this project kept instead' },
    },
  },
  // The `interaction` group: a decision the user makes on a page rather than
  // in the chat, whose answer comes back as JSON the agent can act on.
  'interaction ask': {
    summary: 'Put a question on the phone as a page, and get a link to hand over',
    args: '',
    maxPositionals: 0,
    flags: {
      html: { value: '<file>', help: 'The page to serve — one self-contained HTML file, no external resources; it is checked before the link is issued' },
      purpose: { value: '<text>', help: 'One line for `mp interaction status`: what this asks the user to decide' },
      id: { value: '<id>', help: 'Replace an open question\'s page with a new one (a re-ask after "the premise is wrong"); bumps its revision' },
      ttl: { value: '<min>', default: '120', help: 'Minutes the answer stays readable after it arrives (1–1440)' },
      'form-ttl': { value: '<min>', default: '30', help: 'Minutes the link stays open (1–60)' },
      json: { help: 'Print one machine-readable JSON object on stdout instead of prose' },
    },
  },
  'interaction wait': {
    summary: 'Block until the phone submits, then print the answer as JSON — a timeout is not an error',
    args: '',
    maxPositionals: 0,
    flags: {
      id: { value: '<id>', help: 'Which question to wait on (default: the only open one)' },
      timeout: { value: '<sec>', default: '540', help: 'Seconds to wait before reporting "still waiting" and exiting 0 (the link stays open)' },
      json: { help: 'Print one machine-readable JSON object on stdout instead of prose' },
    },
  },
  'interaction status': {
    summary: 'List open questions: stage, revision, how much is filled in so far',
    args: '',
    maxPositionals: 0,
    flags: {
      json: { help: 'Print a machine-readable JSON array on stdout instead of prose' },
    },
  },
  'interaction close': {
    summary: 'End a question now rather than at its TTL, and drop its answer',
    args: '',
    maxPositionals: 0,
    flags: {
      id: { value: '<id>', help: 'Which question to close (default: the only open one)' },
      all: { help: 'Close every question, including stale ones' },
    },
  },
}

// What `mp <group> --help` says the group is for. A group with no entry here
// is not a group: main() uses this to decide whether a first word is one.
export const GROUPS = {
  secret: 'credentials the phone fills in; the AI may use them but never read them',
  interaction: 'a decision the user makes on a page; the answer comes back as JSON',
}

export function commandGroup(name) {
  return Object.keys(COMMANDS).filter((c) => c.startsWith(`${name} `))
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
    const notes = []
    if (def.default !== undefined) notes.push(`default ${def.default}`)
    if (def.repeat) notes.push('repeatable')
    const tail = notes.length ? `${def.help} (${notes.join('; ')})` : def.help
    return `  ${flagSyntax(n, def).padEnd(width)}  ${tail}`
  })
}

// `mp secret --help`: the group's subcommands, in the shape of the top-level
// listing, so a model that has only seen `mp --help` finds nothing new here.
export function renderGroupHelp(group) {
  const names = commandGroup(group)
  if (!names.length) return null

  const width = Math.max(...names.map((c) => c.length))
  return [
    `mp ${group} — ${GROUPS[group] ?? ''}`,
    '',
    `usage: mp ${group} <subcommand> [options]`,
    '',
    'subcommands:',
    ...names.map((name) => `  ${name.padEnd(width)}  ${COMMANDS[name].summary}`),
    '',
    `Run \`mp ${group} <subcommand> --help\` for one subcommand's options.`,
  ].join('\n')
}

export function renderCommandHelp(name) {
  const spec = COMMANDS[name]
  if (!spec) return null

  // Options go before a `--` separator, never after it: what follows `--`
  // belongs to the command being run.
  const usage = (spec.rest
    ? ['mp', name, '[options]', spec.args]
    : ['mp', name, spec.args, '[options]']).filter(Boolean).join(' ')
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
