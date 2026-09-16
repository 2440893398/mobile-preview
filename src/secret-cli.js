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

// The `mp secret` commands. Everything here prints names, fingerprints, uses
// and time left. Nothing here can print a value: the daemon never sends one
// (secret-daemon.js), so there is nothing to leak by mistake in a format
// string.

export function secretFormUrl(s) {
  return `${s.tunnelUrl}/?${SESSION_TOKEN_QUERY_PARAM}=${s.sessionToken}`
}

function minutesLeft(at, now = Date.now()) {
  return Math.max(0, Math.round((at - now) / 60_000))
}

function fieldLine(f) {
  const fp = f.sha256_8 ? ` (${f.length} chars, sha256 ${f.sha256_8})` : ''
  return `${f.name}${fp}`
}

export function formatSecretAsk({ s, reopen = false }, now = Date.now()) {
  const lines = [
    reopen ? 'approve on the phone:' : 'fill in on the phone:',
    // The url goes on its own bare line, same rule as `mp start`: a link the
    // user cannot copy is a link that never arrives.
    secretFormUrl(s),
    `id: ${s.id} — the link expires in ${minutesLeft(s.formExpiresAt, now)} min; `
    + `values are kept in memory for ${minutesLeft(s.expiresAt, now)} min`,
    `next: mp secret wait --id ${s.id}`,
  ]
  if (reopen) lines.push(`uses awaiting approval: ${(s.pendingUses || []).map((u) => JSON.stringify(u)).join(', ')}`)
  return lines.join('\n')
}

export function formatSecretWait(s, now = Date.now()) {
  const lines = [
    `received ${s.id}: ${(s.fields || []).map(fieldLine).join(', ')}`,
  ]
  if (s.uses?.length) {
    lines.push('approved uses:')
    for (const u of s.uses) lines.push(`  ${u}`)
    lines.push(`values are never printed. Use them with: mp secret run --id ${s.id} -- ${s.uses[0]}`)
  } else {
    lines.push('no uses were approved on the phone. Ask for one with: '
      + `mp secret ask --id ${s.id} --use "<command>"`)
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
      lines.push('  filled')
    } else {
      lines.push(`  starting — ${stageText(s.tunnelStage)}${s.attempt ? ` (attempt ${s.attempt}/${s.tries})` : ''}`)
    }
    lines.push(`  fields: ${(s.fields || []).map(fieldLine).join(', ')}`)
    lines.push(`  uses: ${s.uses?.length ? s.uses.map((u) => JSON.stringify(u)).join(', ') : '(none approved yet)'}`)
    lines.push(`  expires in ${minutesLeft(s.expiresAt, now)} min, runs: ${s.runs || 0}, daemon pid ${s.daemonPid}`)
    lines.push(`  log: ${s.logPath || state.secretLogPath(s.id)}`)
    return lines.join('\n')
  })

  blocks.push('values live only in each daemon\'s memory: `mp secret forget [--id X]` wipes one, '
    + '`mp secret forget --all` wipes every one.')
  return blocks.join('\n\n')
}

export function parseFieldSpec(spec) {
  const m = /^([^:]+)(?::([a-z]+))?$/.exec(String(spec).trim())
  if (!m) return { error: `bad --field ${JSON.stringify(spec)}: use NAME or NAME:kind` }
  const [, name, kind = 'secret'] = m
  if (!FIELD_NAME_RE.test(name)) {
    return { error: `bad --field name ${JSON.stringify(name)}: use letters, digits and _ (it becomes an environment variable)` }
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
    fields: s.fields || [],
    uses: s.uses || [],
    pendingUses: s.pendingUses || [],
    expiresAt: s.expiresAt,
    expiresInMinutes: minutesLeft(s.expiresAt, now),
    formExpiresAt: s.formExpiresAt ?? null,
    runs: s.runs || 0,
    daemonPid: s.daemonPid ?? null,
    logPath: s.logPath || state.secretLogPath(s.id),
  }
}

export function createSecretCommands({
  note, emitJson, fail, parseArgs, numericFlag, here, tunnelWaitBudgetMs,
}) {
  function cleanupSlot(s) {
    for (const pid of new Set([s.tunnelPid, s.daemonPid].filter(Boolean))) {
      if (isAlive(pid)) killTree(pid)
    }
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

  // Waits for a form link to exist (first ask) or to exist again (reopen),
  // narrating the tunnel stages the way `mp start` does.
  async function awaitLink(id, { stopped = () => false, timeoutMs = tunnelWaitBudgetMs() } = {}) {
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
    if (isJson()) {
      emitJson({
        status: 'collecting',
        id: s.id,
        url: secretFormUrl(s),
        formExpiresAt: s.formExpiresAt,
        expiresAt: s.expiresAt,
        pendingUses: s.pendingUses || [],
        reopen,
      })
      return
    }
    console.log(formatSecretAsk({ s, reopen }))
  }

  function settleLink(id, r, { reopen }) {
    if (r.outcome === 'ready') return reportLink(r.s, { reopen })
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

    if (parsed.id !== undefined) {
      const id = requireId(parsed.id)
      const s = requireActive(id)
      if (!s.filledAt) {
        fail(`slot ${id} has not been filled in yet (stage: ${s.stage}); wait for that before adding uses.`, { id })
      }
      if (s.stage === 'collecting') {
        fail(`a form link is already open for ${id}, awaiting approval of: ${
          (s.pendingUses || []).map((u) => JSON.stringify(u)).join(', ')
        }. Wait for it with \`mp secret wait --id ${id}\` or let it expire.`, { id })
      }
      if (!uses.length) fail('--use is required with --id: name the command to get approved.')
      if (parsed.purpose !== undefined || parsed.field !== undefined || parsed.ttl !== undefined || parsed['form-ttl'] !== undefined) {
        note(`--purpose/--field/--ttl/--form-ttl are ignored with --id: slot ${id} keeps what it was created with.`)
      }
      let r
      try {
        r = await secretCall(s.ipcPath, { op: 'reopen', uses })
      } catch (err) {
        fail(`could not reach the secret daemon for ${id}: ${err.message}`, { id })
      }
      if (r.type === 'error') fail(r.error, { id, code: r.code })
      if (r.alreadyApproved) {
        note('every one of those uses is already approved; nothing to send to the phone')
        if (isJson()) emitJson({ status: 'filled', id, uses: s.uses, alreadyApproved: true })
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
    if (!uses.length) {
      note('no --use declared: before running anything with these values the AI will have to ask '
        + 'again with `mp secret ask --id <id> --use "<command>"`, which sends the phone another link.')
    }

    const id = mintSecretId()
    const child = spawn(process.execPath, [
      join(here, 'secret-daemon-entry.js'),
      JSON.stringify({
        id, purpose, fields, uses, ttlMinutes: ttl, formTtlMinutes: formTtl,
      }),
    ], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()

    let exitCode = null
    child.once('exit', (code) => { exitCode = code ?? -1 })

    const result = await awaitLink(id, { stopped: () => exitCode !== null })
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
            fields: s.fields,
            uses: s.uses || [],
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
    const id = resolveId(parsed)
    const s = requireActive(id)
    const cwd = parsed.cwd !== undefined ? resolve(String(parsed.cwd)) : process.cwd()

    let r
    try {
      r = await secretCall(s.ipcPath, { op: 'run', argv, cwd }, {
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
    ask, wait, run, status, forget,
  }
}
