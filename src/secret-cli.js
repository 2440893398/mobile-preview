import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as state from './state.js'
import {
  FIELD_KINDS, FIELD_NAME_RE, mintSecretId, secretHealth,
} from './secret-daemon.js'
import { secretCall } from './secret-client.js'
import { isAlive, killTree, stageText } from './tunnel.js'
import { SESSION_TOKEN_QUERY_PARAM } from './proxy.js'
import { renderCommandHelp } from './usage.js'
import {
  projectRoot, publicView, removeSaved, viewOf,
} from './secret-vault.js'
import { parseRenderSpec, removeKeptFor, removeRendered } from './secret-render.js'

// The `mp secret` commands. Everything here prints names, fingerprints, uses
// and time left. Nothing here can print a value: the daemon never sends one
// (secret-daemon.js), and the vault metadata the CLI reads directly holds only
// ciphertext besides the names and dates, so there is nothing to leak by
// mistake in a format string.

export function secretFormUrl(s) {
  return `${s.tunnelUrl}/?${SESSION_TOKEN_QUERY_PARAM}=${s.sessionToken}`
}

function minutesLeft(at, now = Date.now()) {
  return Math.max(0, Math.round((at - now) / 60_000))
}

function daysAgo(t, now = Date.now()) {
  const d = Math.floor((now - t) / 86_400_000)
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'} ago`
  const h = Math.floor((now - t) / 3_600_000)
  return h >= 1 ? `${h} h ago` : 'just now'
}

function fieldLine(f) {
  const fp = f.sha256_8 ? ` (${f.length} chars, sha256 ${f.sha256_8})` : ''
  return `${f.name}${fp}`
}

const fileLine = (f) => `${f.template} → ${f.out}${f.keep ? ' (kept)' : ''}`

const HEADINGS = {
  fill: 'fill in on the phone:',
  confirm: 'confirm on the phone — these values are saved on this computer, one tap uses them:',
  confirmPassphrase: 'confirm on the phone — these values are saved on this computer; the user enters their passphrase to use them:',
  approve: 'approve on the phone:',
}

export function formatSecretAsk({ s, reopen = false }, now = Date.now()) {
  const mode = reopen ? 'approve' : (s.formMode || 'fill')
  const heading = mode === 'confirm' && s.formLevel === 'passphrase' ? HEADINGS.confirmPassphrase : HEADINGS[mode]
  const lines = [
    heading || HEADINGS.fill,
    // The url goes on its own bare line, same rule as `mp start`: a link the
    // user cannot copy is a link that never arrives.
    secretFormUrl(s),
    `id: ${s.id} — the link expires in ${minutesLeft(s.formExpiresAt, now)} min; `
    + `values are kept in memory for ${minutesLeft(s.expiresAt, now)} min`,
    `next: mp secret wait --id ${s.id}`,
  ]
  if (mode === 'approve') {
    const pending = [
      ...(s.pendingUses || []).map((u) => JSON.stringify(u)),
      ...(s.pendingFiles || []).map((f) => `write ${f.out}`),
    ]
    lines.push(`awaiting approval: ${pending.join(', ')}`)
    if (s.source === 'saved') lines.push('the saved values are already loaded; only the new uses need the phone')
  }
  return lines.join('\n')
}

// `ask` in a project whose values are saved at the "auto" level: nothing to
// hand to the user, the slot is filled already.
export function formatSecretFilled(s, now = Date.now()) {
  const lines = [
    'used saved values — no phone needed:',
    ...(s.fields || []).map((f) => `  ${fieldLine(f)}`),
    `id: ${s.id} — kept in memory for ${minutesLeft(s.expiresAt, now)} min`,
  ]
  if (s.uses?.length) {
    lines.push('approved uses:')
    for (const u of s.uses) lines.push(`  ${u}`)
  }
  if (s.files?.length) {
    lines.push('approved render targets:')
    for (const f of s.files) lines.push(`  ${fileLine(f)}`)
  }
  lines.push(s.uses?.length
    ? `next: mp secret run --id ${s.id} -- ${s.uses[0]}`
    : `no uses are remembered for these values. Ask for one with: mp secret ask --id ${s.id} --use "<command>"`)
  return lines.join('\n')
}

export function formatSecretWait(s, now = Date.now()) {
  const lines = [
    `received ${s.id}: ${(s.fields || []).map(fieldLine).join(', ')}`,
  ]
  if (s.source === 'saved') lines.push('(from values saved on this computer)')
  if (s.savedAs) lines.push(`the user saved these on this computer (level: ${s.savedAs.level})`)
  if (s.uses?.length) {
    lines.push('approved uses:')
    for (const u of s.uses) lines.push(`  ${u}`)
    lines.push(`values are never printed. Use them with: mp secret run --id ${s.id} -- ${s.uses[0]}`)
  } else {
    lines.push('no uses were approved on the phone. Ask for one with: '
      + `mp secret ask --id ${s.id} --use "<command>"`)
  }
  if (s.files?.length) {
    lines.push('approved render targets:')
    for (const f of s.files) lines.push(`  ${fileLine(f)}`)
  }
  lines.push(`kept in memory for ${minutesLeft(s.expiresAt, now)} more min; `
    + `mp secret forget --id ${s.id} ends that early`)
  return lines.join('\n')
}

export function formatSecretStatus(slots, now = Date.now()) {
  if (slots.length === 0) return 'no active secret slot'

  const blocks = slots.map((s) => {
    const lines = [`${s.id} — ${s.purpose}`]
    if (s.stage === 'collecting' && s.tunnelUrl && s.sessionToken) {
      lines.push(`  waiting for the phone (link open for ${minutesLeft(s.formExpiresAt, now)} more min):`)
      lines.push(secretFormUrl(s))
    } else if (s.stage === 'filled') {
      lines.push(`  filled${s.source === 'saved' ? ' from saved values' : ''}`)
    } else {
      lines.push(`  starting — ${stageText(s.tunnelStage)}${s.attempt ? ` (attempt ${s.attempt}/${s.tries})` : ''}`)
    }
    lines.push(`  fields: ${(s.fields || []).map(fieldLine).join(', ')}`)
    lines.push(`  uses: ${s.uses?.length ? s.uses.map((u) => JSON.stringify(u)).join(', ') : '(none approved yet)'}`)
    if (s.files?.length) lines.push(`  render targets: ${s.files.map(fileLine).join(', ')}`)
    if (s.renderedFiles?.length) lines.push(`  rendered now: ${s.renderedFiles.map((f) => f.path).join(', ')}`)
    lines.push(`  expires in ${minutesLeft(s.expiresAt, now)} min, runs: ${s.runs || 0}, daemon pid ${s.daemonPid}`)
    lines.push(`  log: ${s.logPath || state.secretLogPath(s.id)}`)
    return lines.join('\n')
  })

  blocks.push('values live only in each daemon\'s memory: `mp secret forget [--id X]` wipes one, '
    + '`mp secret forget --all` wipes every one. Values the user saved are listed by `mp secret saved`.')
  return blocks.join('\n\n')
}

function expiryText(meta, now) {
  if (!meta.expiresAt) return 'never expires'
  if (meta.status === 'expired') return 'EXPIRED'
  return `expires in ${Math.max(0, Math.ceil((meta.expiresAt - now) / 86_400_000))} days`
}

export function formatSaved(views, now = Date.now()) {
  const live = views.filter((v) => Object.keys(v.fields).length || v.uses.length || v.files.length || v.kept?.length)
  if (!live.length) return 'nothing is saved for this project'
  const blocks = live.map((v) => {
    const lines = [`saved for ${v.root}:`]
    for (const [name, m] of Object.entries(v.fields)) {
      lines.push(`  ${name} — ${m.level}, ${m.length} chars, sha256 ${m.sha256_8}, saved ${daysAgo(m.savedAt, now)}, `
        + `${expiryText(m, now)}, used ${m.useCount ?? 0}×, last ${daysAgo(m.lastUsedAt ?? m.savedAt, now)}`)
    }
    if (v.uses.length) {
      lines.push('  remembered uses:')
      for (const u of v.uses) lines.push(`    ${u.use}  (${(u.fields || []).join(', ')})`)
    }
    if (v.files.length) {
      lines.push('  remembered render targets:')
      for (const f of v.files) lines.push(`    ${fileLine(f)}  (${(f.fields || []).join(', ')})`)
    }
    if (v.kept?.length) lines.push(`  kept rendered files: ${v.kept.map((f) => f.path).join(', ')}`)
    return lines.join('\n')
  })
  blocks.push('values are never printed. `mp secret forget --saved [NAME…]` deletes them; '
    + 'the level of a saved value can only be changed on the phone, by filling it in again.')
  return blocks.join('\n\n')
}

export function parseFieldSpec(spec) {
  const m = /^([^:]+)(?::([a-z]+))?$/.exec(String(spec).trim())
  if (!m) return { error: `bad --field ${JSON.stringify(spec)}: use NAME or NAME:kind` }
  const [, name, kind = 'secret'] = m
  if (!FIELD_NAME_RE.test(name)) {
    return {
      error: `bad --field name ${JSON.stringify(name)}: use letters, digits and _ (it becomes an environment variable)`
        + `${name.startsWith('__mp_') ? '; names starting with __mp_ are reserved' : ''}`,
    }
  }
  if (!FIELD_KINDS.includes(kind)) {
    return { error: `bad --field kind ${JSON.stringify(kind)} for ${name}: one of ${FIELD_KINDS.join(', ')}` }
  }
  return { name, kind }
}

function statusView(s, now = Date.now()) {
  return {
    id: s.id,
    purpose: s.purpose,
    stage: s.stage,
    url: s.stage === 'collecting' && s.tunnelUrl && s.sessionToken ? secretFormUrl(s) : null,
    formMode: s.formMode ?? null,
    projectRoot: s.projectRoot ?? null,
    source: s.source ?? null,
    fields: s.fields || [],
    uses: s.uses || [],
    files: s.files || [],
    renderedFiles: s.renderedFiles || [],
    pendingUses: s.pendingUses || [],
    pendingFiles: s.pendingFiles || [],
    expiresAt: s.expiresAt,
    expiresInMinutes: minutesLeft(s.expiresAt, now),
    formExpiresAt: s.formExpiresAt ?? null,
    runs: s.runs || 0,
    daemonPid: s.daemonPid ?? null,
    logPath: s.logPath || state.secretLogPath(s.id),
  }
}

function savedView(v) {
  return {
    root: v.root,
    fields: Object.entries(v.fields).map(([name, m]) => ({ name, ...m })),
    uses: v.uses,
    files: v.files,
    kept: v.kept || [],
  }
}

export function createSecretCommands({
  note, emitJson, fail, parseArgs, numericFlag, here, tunnelWaitBudgetMs,
}) {
  function cleanupSlot(s) {
    for (const pid of new Set([s.tunnelPid, s.daemonPid].filter(Boolean))) {
      if (isAlive(pid)) killTree(pid)
    }
    // A daemon that died without cleaning up leaves its rendered files
    // behind; the state file outlives it precisely so they can be found.
    for (const f of s.renderedFiles || []) removeRendered(f.path)
    state.clearSecret(s.id)
    if (process.platform !== 'win32' && s.ipcPath && existsSync(s.ipcPath)) rmSync(s.ipcPath, { force: true })
  }

  function activeSlots() {
    return state.listSecrets().filter((s) => secretHealth(s).active)
  }

  function requireId(raw) {
    const id = String(raw).trim()
    if (!state.SECRET_ID_RE.test(id)) fail(`bad --id ${JSON.stringify(raw)}: ids look like s-7f3a1c`)
    return id
  }

  // Same rule as the preview's port resolution: never guess between several.
  function resolveId(parsed) {
    if (parsed.id !== undefined) return requireId(parsed.id)
    const live = activeSlots()
    if (live.length === 0) fail('no active secret slot. Run `mp secret ask` first.')
    if (live.length > 1) {
      fail(`several secret slots are active (${live.map((s) => s.id).join(', ')}); pass --id.`)
    }
    return live[0].id
  }

  function requireActive(id) {
    const s = state.readSecret(id)
    if (s?.error) fail(s.error, { id, status: 'error' })
    if (!secretHealth(s).active) {
      fail(`no active secret slot ${id}. \`mp secret status\` lists the live ones.`, { id })
    }
    return s
  }

  function parseRenders(parsed) {
    const out = []
    for (const [flag, keep] of [['render', false], ['render-keep', true]]) {
      for (const spec of parsed[flag] || []) {
        const r = parseRenderSpec(spec, process.cwd())
        if (r.error) fail(r.error)
        out.push({ template: r.template, out: r.out, keep })
      }
    }
    return out
  }

  // Waits for a form link to exist (first ask) or to exist again (reopen),
  // narrating the tunnel stages the way `mp start` does. A slot filled from
  // saved values never gets a link; that is an outcome of its own.
  async function awaitLink(id, { stopped = () => false, timeoutMs = tunnelWaitBudgetMs(), allowFilled = false } = {}) {
    const deadline = Date.now() + timeoutMs
    let announced = null
    let latest = null

    for (;;) {
      const s = state.readSecret(id)
      if (s) {
        latest = s
        if (s.error) return { s, outcome: 'error' }
        if (s.reopenError) return { s, outcome: 'reopen-error' }
        if (s.stage === 'collecting' && s.tunnelUrl && s.sessionToken) return { s, outcome: 'ready' }
        if (allowFilled && s.stage === 'filled') return { s, outcome: 'filled' }
        const key = `${s.tunnelStage}:${s.attempt ?? ''}`
        if (s.tunnelStage && key !== announced) {
          announced = key
          note(`... ${stageText(s.tunnelStage)}${s.attempt && s.tries ? ` (attempt ${s.attempt}/${s.tries})` : ''}`)
        }
      }
      if (stopped()) return { s: state.readSecret(id) || latest, outcome: 'stopped' }
      if (Date.now() >= deadline) return { s: latest, outcome: 'timeout' }
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  function reportLink(s, { reopen }) {
    if (s.vaultError) note(`saving is unavailable: ${s.vaultError}`)
    if (isJson()) {
      emitJson({
        status: 'collecting',
        id: s.id,
        url: secretFormUrl(s),
        formMode: reopen ? 'approve' : (s.formMode || 'fill'),
        source: s.source ?? null,
        formExpiresAt: s.formExpiresAt,
        expiresAt: s.expiresAt,
        pendingUses: s.pendingUses || [],
        pendingFiles: s.pendingFiles || [],
        reopen,
      })
      return
    }
    console.log(formatSecretAsk({ s, reopen }))
  }

  function reportFilled(s) {
    if (isJson()) {
      emitJson({
        status: 'filled',
        id: s.id,
        source: 'saved',
        level: s.level ?? null,
        fields: s.fields,
        uses: s.uses || [],
        files: s.files || [],
        expiresAt: s.expiresAt,
        expiresInMinutes: minutesLeft(s.expiresAt),
      })
      return
    }
    console.log(formatSecretFilled(s))
  }

  function settleLink(id, r, { reopen }) {
    if (r.outcome === 'ready') return reportLink(r.s, { reopen })
    if (r.outcome === 'filled') return reportFilled(r.s)
    if (r.outcome === 'error') {
      const detail = { id, reason: r.s.errorReason, logPath: r.s.logPath ?? state.secretTunnelLogPath(id) }
      state.clearSecret(id)
      return fail(r.s.error, detail)
    }
    if (r.outcome === 'reopen-error') {
      return fail(`could not open a new form link for ${id}: ${r.s.reopenError}. The values are still held; try again.`, { id })
    }
    if (r.outcome === 'stopped') {
      return fail(`the secret daemon for ${id} exited before the form link came up. See ${state.secretTunnelLogPath(id)}.`, { id })
    }
    const alive = Boolean(r.s?.daemonPid && isAlive(r.s.daemonPid))
    return fail(
      `timed out waiting for the form link for ${id}. last stage: ${stageText(r.s?.tunnelStage)}. `
      + (alive
        ? `the daemon (pid ${r.s.daemonPid}) is still trying — \`mp secret status\` shortly, or \`mp secret forget --id ${id}\` to give up.`
        : `no daemon is running for ${id} any more — run \`mp secret ask\` again.`)
      + ` cloudflared output: ${state.secretTunnelLogPath(id)}`,
      { id, status: alive ? 'starting' : 'error', logPath: state.secretTunnelLogPath(id) },
    )
  }

  // jsonMode lives in cli.js; the emitJson passed in is only called when it
  // is on, so the commands here ask the same question the same way.
  let jsonFlag = false
  const isJson = () => jsonFlag

  async function ask(args) {
    const parsed = parseArgs(args, 'secret ask')
    if (parsed.help) return console.log(renderCommandHelp('secret ask'))
    jsonFlag = Boolean(parsed.json)

    const uses = (parsed.use || []).map((u) => String(u).trim()).filter(Boolean)
    const renders = parseRenders(parsed)

    if (parsed.id !== undefined) {
      const id = requireId(parsed.id)
      const s = requireActive(id)
      if (!s.filledAt) {
        fail(`slot ${id} has not been filled in yet (stage: ${s.stage}); wait for that before adding uses.`, { id })
      }
      if (s.stage === 'collecting') {
        fail(`a form link is already open for ${id}, awaiting approval of: ${
          [...(s.pendingUses || []).map((u) => JSON.stringify(u)), ...(s.pendingFiles || []).map((f) => f.out)].join(', ')
        }. Wait for it with \`mp secret wait --id ${id}\` or let it expire.`, { id })
      }
      if (!uses.length && !renders.length) fail('--use or --render is required with --id: name what to get approved.')
      if (parsed.purpose !== undefined || parsed.field !== undefined || parsed.ttl !== undefined
        || parsed['form-ttl'] !== undefined || parsed.refill) {
        note(`--purpose/--field/--ttl/--form-ttl/--refill are ignored with --id: slot ${id} keeps what it was created with.`)
      }
      let r
      try {
        r = await secretCall(s.ipcPath, { op: 'reopen', uses, files: renders })
      } catch (err) {
        fail(`could not reach the secret daemon for ${id}: ${err.message}`, { id })
      }
      if (r.type === 'error') fail(r.error, { id, code: r.code })
      if (r.alreadyApproved) {
        note('every one of those is already approved; nothing to send to the phone')
        if (isJson()) emitJson({ status: 'filled', id, uses: s.uses, files: s.files || [], alreadyApproved: true })
        return
      }
      const result = await awaitLink(id, { stopped: () => !isAlive(s.daemonPid) })
      return settleLink(id, result, { reopen: true })
    }

    const purpose = String(parsed.purpose ?? '').trim()
    if (!purpose) fail('--purpose is required: one line telling the user what these values are for.')
    const fields = (parsed.field || []).map(parseFieldSpec)
    const bad = fields.find((f) => f.error)
    if (bad) fail(bad.error)
    if (!fields.length) fail('at least one --field is required, e.g. --field OSS_ACCESS_KEY_SECRET')
    const dup = fields.map((f) => f.name).find((n, i, a) => a.indexOf(n) !== i)
    if (dup) fail(`--field ${dup} is given twice`)
    const ttl = numericFlag(parsed, 'ttl', 120, { integer: true, min: 1, max: 1440 })
    const formTtl = numericFlag(parsed, 'form-ttl', 30, { integer: true, min: 1, max: 60 })
    if (!uses.length && !renders.length) {
      note('no --use declared: unless uses are remembered for saved values, running anything with these values '
        + 'will need `mp secret ask --id <id> --use "<command>"`, which sends the phone another link.')
    }

    const id = mintSecretId()
    const child = spawn(process.execPath, [
      join(here, 'secret-daemon-entry.js'),
      JSON.stringify({
        id,
        purpose,
        fields,
        uses,
        renders,
        refill: Boolean(parsed.refill),
        projectRoot: projectRoot(process.cwd()),
        ttlMinutes: ttl,
        formTtlMinutes: formTtl,
      }),
    ], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()

    let exitCode = null
    child.once('exit', (code) => { exitCode = code ?? -1 })

    const result = await awaitLink(id, { stopped: () => exitCode !== null, allowFilled: true })
    return settleLink(id, result, { reopen: false })
  }

  async function wait(args) {
    const parsed = parseArgs(args, 'secret wait')
    if (parsed.help) return console.log(renderCommandHelp('secret wait'))
    jsonFlag = Boolean(parsed.json)

    const id = resolveId(parsed)
    const timeout = numericFlag(parsed, 'timeout', 540, { integer: true, min: 1, max: 3600 })
    const deadline = Date.now() + timeout * 1000

    for (;;) {
      const s = state.readSecret(id)
      if (!s) fail(`secret slot ${id} is gone — it was forgotten, or its daemon expired.`, { id })
      if (s.error) {
        // The daemon has already exited; the record only existed so this
        // command could say why. Nothing else will clean it up.
        state.clearSecret(id)
        fail(s.error, { id, reason: s.errorReason })
      }
      if (s.stage === 'filled') {
        if (isJson()) {
          emitJson({
            status: 'filled',
            id,
            source: s.source ?? 'form',
            fields: s.fields,
            uses: s.uses || [],
            files: s.files || [],
            savedAs: s.savedAs ?? null,
            expiresAt: s.expiresAt,
            expiresInMinutes: minutesLeft(s.expiresAt),
          })
        } else {
          console.log(formatSecretWait(s))
        }
        return
      }
      if (!isAlive(s.daemonPid)) {
        state.clearSecret(id)
        fail(`the secret daemon for ${id} exited before anything arrived.`, { id })
      }
      if (Date.now() >= deadline) {
        const open = s.formExpiresAt ? `the link is still open for ${minutesLeft(s.formExpiresAt)} more min; ` : ''
        fail(`still waiting for the phone after ${timeout}s. ${open}run \`mp secret wait --id ${id}\` again.`,
          { id, status: 'collecting', formExpiresAt: s.formExpiresAt ?? null })
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  async function run(args) {
    const parsed = parseArgs(args, 'secret run')
    if (parsed.help) return console.log(renderCommandHelp('secret run'))

    const argv = parsed.rest
    if (!argv?.length) fail('give the command after --, e.g. mp secret run --id s-7f3a1c -- npm run deploy')
    const renders = parseRenders(parsed).map(({ template, out }) => ({ template, out }))
    const id = resolveId(parsed)
    const s = requireActive(id)
    const cwd = parsed.cwd !== undefined ? resolve(String(parsed.cwd)) : process.cwd()

    let r
    try {
      r = await secretCall(s.ipcPath, {
        op: 'run', argv, cwd, renders,
      }, {
        onEvent: (ev) => {
          if (ev.type === 'stdout') process.stdout.write(ev.data)
          else if (ev.type === 'stderr') process.stderr.write(ev.data)
        },
      })
    } catch (err) {
      fail(`could not reach the secret daemon for ${id}: ${err.message}`, { id })
    }
    if (r.type === 'error') fail(r.error, { id, code: r.code })
    process.exitCode = r.code ?? (r.signal ? 1 : 0)
  }

  async function render(args) {
    const parsed = parseArgs(args, 'secret render')
    if (parsed.help) return console.log(renderCommandHelp('secret render'))
    if (!parsed.positionals.length) fail('name at least one TEMPLATE=OUTPUT, e.g. mp secret render config.yml.tpl=config.yml')
    const renders = parsed.positionals.map((spec) => {
      const r = parseRenderSpec(spec, process.cwd())
      if (r.error) fail(r.error)
      return { template: r.template, out: r.out }
    })
    const id = resolveId(parsed)
    const s = requireActive(id)
    let r
    try {
      r = await secretCall(s.ipcPath, { op: 'render', renders })
    } catch (err) {
      fail(`could not reach the secret daemon for ${id}: ${err.message}`, { id })
    }
    if (r.type === 'error') fail(r.error, { id, code: r.code })
    for (const f of r.rendered) {
      console.log(`wrote ${f.path} (${f.lifetime === 'keep' ? 'kept until `mp secret forget --files`' : `deleted when ${id} ends`})`)
    }
    note(`the file holds the real values: do not read it. \`mp secret peek --id ${id} <file>\` shows it redacted.`)
  }

  async function peek(args) {
    const parsed = parseArgs(args, 'secret peek')
    if (parsed.help) return console.log(renderCommandHelp('secret peek'))
    const [file] = parsed.positionals
    if (!file) fail('name the rendered file, e.g. mp secret peek config.yml')
    const id = resolveId(parsed)
    const s = requireActive(id)
    let r
    try {
      r = await secretCall(s.ipcPath, { op: 'peek', path: resolve(String(file)) })
    } catch (err) {
      fail(`could not reach the secret daemon for ${id}: ${err.message}`, { id })
    }
    if (r.type === 'error') fail(r.error, { id, code: r.code })
    process.stdout.write(r.content.endsWith('\n') ? r.content : `${r.content}\n`)
  }

  function saved(args) {
    const parsed = parseArgs(args, 'secret saved')
    if (parsed.help) return console.log(renderCommandHelp('secret saved'))
    jsonFlag = Boolean(parsed.json)

    const kept = state.readKeptFiles()
    const withKept = (v) => ({ ...v, kept: kept.filter((f) => f.project === v.root) })
    const views = parsed.all
      ? state.listVaultProjects().map((p) => withKept(viewOf(p, p.pid, p.root)))
      : [withKept(publicView(projectRoot(process.cwd())))]
    if (views.some((v) => v.corrupt)) note(`the saved values for ${views.find((v) => v.corrupt).root} are unreadable; \`mp secret forget --saved\` there clears them`)

    if (isJson()) emitJson(views.filter((v) => !v.corrupt).map(savedView))
    else console.log(formatSaved(views.filter((v) => !v.corrupt)))
  }

  function status(args) {
    const parsed = parseArgs(args, 'secret status')
    if (parsed.help) return console.log(renderCommandHelp('secret status'))
    jsonFlag = Boolean(parsed.json)

    const live = []
    for (const s of state.listSecrets()) {
      if (s.error) {
        note(`${s.id}: ${s.error}`)
        if (!isAlive(s.daemonPid)) cleanupSlot(s)
        continue
      }
      const health = secretHealth(s)
      if (health.active) {
        live.push(s)
        continue
      }
      note(`${s.id}: previous slot ${health.reason === 'expired' ? 'has expired' : 'is stale'}; cleaning up`)
      cleanupSlot(s)
    }

    if (isJson()) emitJson(live.map((s) => statusView(s)))
    else console.log(formatSecretStatus(live))
  }

  async function forgetOne(s) {
    if (s.daemonPid && isAlive(s.daemonPid) && s.ipcPath) {
      try {
        await secretCall(s.ipcPath, { op: 'forget' }, { connectTimeoutMs: 2_000 })
        // Give the daemon a moment to wipe and exit on its own. A daemon
        // that has cleared its own slot has done the wiping — the process
        // going away is a formality — so only what is still holding a record
        // after the grace is killed like any other stale slot.
        for (let i = 0; i < 20 && isAlive(s.daemonPid); i += 1) {
          await new Promise((r) => setTimeout(r, 50))
        }
        if (!state.readSecret(s.id)) return
      } catch {
        // fall through to the kill below
      }
    }
    cleanupSlot(s)
  }

  async function forget(args) {
    const parsed = parseArgs(args, 'secret forget')
    if (parsed.help) return console.log(renderCommandHelp('secret forget'))

    if (parsed.saved || parsed.files) {
      if (parsed.id !== undefined || parsed.all) fail('--saved and --files act on this project\'s saved values and files; they do not take --id or --all.')
      if (parsed.positionals.length && !parsed.saved) fail('field names are only for --saved')
      const root = projectRoot(process.cwd())
      if (parsed.saved) {
        const { removed } = removeSaved(root, parsed.positionals.length ? parsed.positionals : null)
        note(removed.length ? `deleted saved values for ${root}: ${removed.join(', ')}` : `nothing was saved for ${root}${parsed.positionals.length ? ' under those names' : ''}`)
      }
      if (parsed.files) {
        const gone = removeKeptFor(root)
        note(gone.length ? `deleted kept files: ${gone.join(', ')}` : `no kept files for ${root}`)
      }
      return
    }
    if (parsed.positionals.length) fail('field names are only for --saved')

    if (parsed.all) {
      const all = state.listSecrets()
      for (const s of all) await forgetOne(s)
      note(`forgot ${all.length} secret slot(s)`)
      return
    }

    if (parsed.id === undefined && activeSlots().length === 0) {
      // Same contract as `mp stop`: "make sure nothing is held" is already
      // true, so sweep whatever stale records remain and report success.
      const stale = state.listSecrets()
      for (const s of stale) await forgetOne(s)
      note(`forgot 0 active secret slot(s)${stale.length ? ` (${stale.length} stale record(s) cleaned up)` : ''}`)
      return
    }

    const id = resolveId(parsed)
    const s = state.readSecret(id)
    if (!s) fail(`no secret slot ${id}.`, { id })
    await forgetOne(s)
    note(`forgot ${id}`)
  }

  return {
    ask, wait, run, render, peek, saved, status, forget,
  }
}
