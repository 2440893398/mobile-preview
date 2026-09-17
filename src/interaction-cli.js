import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as state from './state.js'
import { checkPage } from './interaction-page.js'
import { interactionHealth, mintInteractionId } from './interaction-daemon.js'
// The same one-request-per-connection IPC client the secret commands use;
// nothing about it is secret-specific.
import { secretCall as ipcCall } from './secret-client.js'
import { isAlive, killTree, stageText } from './tunnel.js'
import { SESSION_TOKEN_QUERY_PARAM } from './proxy.js'
import { renderCommandHelp } from './usage.js'

// The `mp interaction` commands. The mirror image of `mp secret`: that one
// sends the phone a form and is careful never to print what comes back, this
// one sends the phone a question and exists to print exactly that.
//
// The one rule worth stating: `wait` timing out is not an error. A person
// thinking about a decision routinely takes longer than any tool call may
// block for, so a timeout exits 0 and says "still waiting", with whatever is
// already filled in. Exiting non-zero there would make the agent treat a
// person reading carefully as a failure.

export function interactionUrl(s) {
  return `${s.tunnelUrl}/?${SESSION_TOKEN_QUERY_PARAM}=${s.sessionToken}`
}

function minutesLeft(at, now = Date.now()) {
  return Math.max(0, Math.round((at - now) / 60_000))
}

export function formatInteractionAsk(s, { reopen = false } = {}, now = Date.now()) {
  return [
    reopen ? `revision ${s.revision} — answer on the phone:` : 'answer on the phone:',
    // Bare line of its own, same rule as `mp start`: a link the user cannot
    // copy is a link that never arrives.
    interactionUrl(s),
    `id: ${s.id} — the link is open for ${minutesLeft(s.formExpiresAt, now)} min; `
    + `the answer is kept for ${minutesLeft(s.expiresAt, now)} min`,
    `next: mp interaction wait --id ${s.id}`,
  ].join('\n')
}

export function formatInteractionWait(s, payload) {
  const r = payload.response
  if (payload.status === 'submitted') {
    const head = r.disposition === 'answered'
      ? `${s.id} answered (revision ${r.revision}).`
      : `${s.id} came back as ${r.disposition}${r.reason ? ` — ${r.reason}` : ''} (revision ${r.revision}).`
    return [head, JSON.stringify(r.answers, null, 2)].join('\n')
  }
  const filled = payload.draft ? Object.keys(payload.draft.answers || {}).length : 0
  const lines = payload.status === 'expired_link'
    ? [`${s.id}: the link expired before it was submitted.`]
    : [`${s.id}: still waiting — the link is open for ${minutesLeft(s.formExpiresAt)} more min.`]
  if (filled) {
    lines.push(`${filled} item(s) filled in so far:`)
    lines.push(JSON.stringify(payload.draft.answers, null, 2))
  }
  lines.push(payload.status === 'expired_link'
    ? `reopen it with: mp interaction ask --id ${s.id} --html <file>`
    : `keep waiting with: mp interaction wait --id ${s.id}`)
  return lines.join('\n')
}

// An answer whose daemon is gone — the machine rebooted, the process was
// killed — but which nobody has read yet. `status` keeps the record on
// purpose; saying nothing about it here would make the only copy of a
// decision someone already made invisible.
export function isUnreadAnswer(s) {
  return Boolean(s?.response && !s.deliveredAt)
}

export function formatInteractionStatus(slots, now = Date.now(), held = []) {
  if (slots.length === 0 && held.length === 0) return 'no open interaction'

  const blocks = slots.map((s) => {
    const lines = [`${s.id} — ${s.purpose}`]
    if (s.stage === 'collecting' && s.tunnelUrl && s.sessionToken) {
      lines.push(`  waiting for the phone (link open for ${minutesLeft(s.formExpiresAt, now)} more min):`)
      lines.push(interactionUrl(s))
    } else if (s.stage === 'submitted') {
      lines.push(`  answered — ${s.response?.disposition}${s.deliveredAt ? ', already handed to the agent' : ', not read yet'}`)
    } else if (s.stage === 'expired_link') {
      lines.push('  the link expired unanswered')
    } else {
      lines.push(`  starting — ${stageText(s.tunnelStage)}${s.attempt ? ` (attempt ${s.attempt}/${s.tries})` : ''}`)
    }
    const filled = s.draft ? Object.keys(s.draft.answers || {}).length : 0
    if (filled) lines.push(`  draft: ${filled} item(s) filled in`)
    lines.push(`  revision ${s.revision}, expires in ${minutesLeft(s.expiresAt, now)} min, daemon pid ${s.daemonPid}`)
    lines.push(`  log: ${s.logPath || state.interactionLogPath(s.id)}`)
    return lines.join('\n')
  })

  for (const s of held) {
    blocks.push([
      `${s.id} — ${s.purpose}`,
      `  came back as ${s.response?.disposition ?? 'answered'}; nobody has read it — its daemon is gone, the answer is not`,
      `  read it with: mp interaction wait --id ${s.id}`,
      `  expires in ${minutesLeft(s.expiresAt, now)} min`,
    ].join('\n'))
  }

  blocks.push('`mp interaction close [--id X]` ends one early, `--all` ends every one.')
  return blocks.join('\n\n')
}

export function createInteractionCommands({
  note, emitJson, fail, parseArgs, numericFlag, here, tunnelWaitBudgetMs,
}) {
  let jsonFlag = false
  const isJson = () => jsonFlag

  function cleanupSlot(s) {
    for (const pid of new Set([s.tunnelPid, s.daemonPid].filter(Boolean))) {
      if (isAlive(pid)) killTree(pid)
    }
    state.clearInteraction(s.id)
    if (process.platform !== 'win32' && s.ipcPath && existsSync(s.ipcPath)) rmSync(s.ipcPath, { force: true })
  }

  function activeSlots() {
    return state.listInteractions().filter((s) => interactionHealth(s).active)
  }

  function requireId(raw) {
    const id = String(raw).trim()
    if (!state.INTERACTION_ID_RE.test(id)) fail(`bad --id ${JSON.stringify(raw)}: ids look like i-7f3a1c`)
    return id
  }

  // A record whose daemon died still holding an answer nobody read. It is not
  // active, but it is exactly what a `wait` after a reboot — or after a
  // compaction lost the id — is looking for.
  function heldAnswers() {
    return state.listInteractions()
      .filter((s) => !interactionHealth(s).active && isUnreadAnswer(s) && Date.now() <= s.expiresAt)
  }

  // Same rule as the preview's port resolution: never guess between several.
  function resolveId(parsed) {
    if (parsed.id !== undefined) return requireId(parsed.id)
    const live = [...activeSlots(), ...heldAnswers()]
    if (live.length === 0) fail('no open interaction. Run `mp interaction ask` first.')
    if (live.length > 1) {
      fail(`several interactions are open (${live.map((s) => s.id).join(', ')}); pass --id.`)
    }
    return live[0].id
  }

  // Reads the page the model wrote and refuses it here, where the reasons can
  // be read and acted on, rather than on the phone where they cannot.
  function loadPage(parsed) {
    if (parsed.html === undefined) fail('--html is required: the page to put in front of the user.')
    const file = resolve(String(parsed.html))
    let html
    try {
      html = readFileSync(file, 'utf8')
    } catch (err) {
      return fail(`could not read ${file}: ${err?.message || err}`)
    }
    const verdict = checkPage(html)
    if (!verdict.ok) {
      return fail(
        `${file} does not meet the interaction page contract:\n`
        + verdict.problems.map((p) => `  - ${p}`).join('\n'),
        { status: 'rejected', problems: verdict.problems, file },
      )
    }
    for (const w of verdict.warnings) note(`note: ${w}`)
    return { html, file, verdict }
  }

  async function awaitLink(id, { stopped = () => false, timeoutMs = tunnelWaitBudgetMs() } = {}) {
    const deadline = Date.now() + timeoutMs
    let announced = null
    let latest = null

    for (;;) {
      const s = state.readInteraction(id)
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
      if (stopped()) return { s: state.readInteraction(id) || latest, outcome: 'stopped' }
      if (Date.now() >= deadline) return { s: latest, outcome: 'timeout' }
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  function settleLink(id, r, { reopen }) {
    if (r.outcome === 'ready') {
      if (isJson()) {
        return emitJson({
          status: 'collecting',
          id: r.s.id,
          url: interactionUrl(r.s),
          revision: r.s.revision,
          formExpiresAt: r.s.formExpiresAt,
          expiresAt: r.s.expiresAt,
          reopen,
        })
      }
      return console.log(formatInteractionAsk(r.s, { reopen }))
    }
    if (r.outcome === 'error') {
      const detail = { id, reason: r.s.errorReason, logPath: r.s.logPath ?? state.interactionTunnelLogPath(id) }
      state.clearInteraction(id)
      return fail(r.s.error, detail)
    }
    if (r.outcome === 'reopen-error') {
      return fail(`could not open a new link for ${id}: ${r.s.reopenError}. The question is still held; try again.`, { id })
    }
    if (r.outcome === 'stopped') {
      return fail(`the interaction daemon for ${id} exited before the link came up. See ${state.interactionTunnelLogPath(id)}.`, { id })
    }
    const alive = Boolean(r.s?.daemonPid && isAlive(r.s.daemonPid))
    return fail(
      `timed out waiting for the link for ${id}. last stage: ${stageText(r.s?.tunnelStage)}. `
      + (alive
        ? `the daemon (pid ${r.s.daemonPid}) is still trying — \`mp interaction status\` shortly, or \`mp interaction close --id ${id}\` to give up.`
        : `no daemon is running for ${id} any more — run \`mp interaction ask\` again.`)
      + ` cloudflared output: ${state.interactionTunnelLogPath(id)}`,
      { id, status: alive ? 'starting' : 'error', logPath: state.interactionTunnelLogPath(id) },
    )
  }

  async function ask(args) {
    const parsed = parseArgs(args, 'interaction ask')
    if (parsed.help) return console.log(renderCommandHelp('interaction ask'))
    jsonFlag = Boolean(parsed.json)

    const { html } = loadPage(parsed)

    // Re-ask: same question, new page. The old answer moves to history and
    // the revision goes up, so a tab still showing the previous page cannot
    // answer the new one by accident.
    if (parsed.id !== undefined) {
      const id = requireId(parsed.id)
      const s = state.readInteraction(id)
      if (s?.error) fail(s.error, { id, status: 'error' })
      if (!interactionHealth(s).active) {
        fail(`no open interaction ${id}. \`mp interaction status\` lists the live ones.`, { id })
      }
      if (parsed.purpose !== undefined || parsed.ttl !== undefined || parsed['form-ttl'] !== undefined) {
        note(`--purpose/--ttl/--form-ttl are ignored with --id: ${id} keeps what it was created with.`)
      }
      let r
      try {
        r = await ipcCall(s.ipcPath, { op: 'reopen', html }, { connectTimeoutMs: 10_000 })
      } catch (err) {
        fail(`could not reach the interaction daemon for ${id}: ${err.message}`, { id })
      }
      if (r.type === 'error') fail(r.error, { id, code: r.code, problems: r.problems })
      const result = await awaitLink(id, { stopped: () => !isAlive(s.daemonPid) })
      return settleLink(id, result, { reopen: true })
    }

    const purpose = String(parsed.purpose ?? '').trim()
    if (!purpose) fail('--purpose is required: one line saying what this asks the user to decide.')
    const ttl = numericFlag(parsed, 'ttl', 120, { integer: true, min: 1, max: 1440 })
    const formTtl = numericFlag(parsed, 'form-ttl', 30, { integer: true, min: 1, max: 60 })

    const id = mintInteractionId()
    // The page goes to disk rather than into the daemon's command line:
    // Windows caps that at ~32 KB and a page may be far larger.
    const pagePath = state.interactionPagePath(id)
    mkdirSync(dirname(pagePath), { recursive: true })
    writeFileSync(pagePath, html, 'utf8')

    const child = spawn(process.execPath, [
      join(here, 'interaction-daemon-entry.js'),
      JSON.stringify({ id, purpose, htmlPath: pagePath, ttlMinutes: ttl, formTtlMinutes: formTtl }),
    ], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()

    let exitCode = null
    child.once('exit', (code) => { exitCode = code ?? -1 })

    const result = await awaitLink(id, { stopped: () => exitCode !== null })
    if (result.outcome !== 'ready') rmSync(pagePath, { force: true })
    return settleLink(id, result, { reopen: false })
  }

  async function wait(args) {
    const parsed = parseArgs(args, 'interaction wait')
    if (parsed.help) return console.log(renderCommandHelp('interaction wait'))
    jsonFlag = Boolean(parsed.json)

    const id = resolveId(parsed)
    // 540s by default because a tool call typically may not block for more
    // than 10 minutes; the remaining minute is for reporting the result.
    const timeout = numericFlag(parsed, 'timeout', 540, { integer: true, min: 1, max: 3600 })
    const deadline = Date.now() + timeout * 1000

    for (;;) {
      const s = state.readInteraction(id)
      if (!s) fail(`interaction ${id} is gone — it was closed, or its daemon expired.`, { id })
      if (s.error) {
        state.clearInteraction(id)
        fail(s.error, { id, reason: s.errorReason })
      }

      if (s.stage === 'submitted' && s.response) {
        const payload = {
          status: 'submitted',
          id,
          revision: s.response.revision,
          disposition: s.response.disposition,
          reason: s.response.reason ?? null,
          answers: s.response.answers,
          responseId: s.response.responseId,
          receiptId: s.response.receiptId,
          receivedAt: s.response.receivedAt,
          expiresAt: s.expiresAt,
          next: `mp interaction close --id ${id}`,
        }
        // Idempotent on purpose: a second `wait` after the answer was already
        // read returns the same thing rather than an error. A compacted
        // context that lost the first copy has to be able to ask again.
        if (!s.deliveredAt) {
          try {
            state.writeInteraction(id, { deliveredAt: Date.now() })
          } catch {
            // Reporting the answer matters more than recording that we did.
          }
        }
        if (isJson()) emitJson(payload)
        else console.log(formatInteractionWait(s, { status: 'submitted', response: s.response }))
        return
      }

      const daemonGone = !isAlive(s.daemonPid)
      if (s.stage === 'expired_link' || daemonGone || Date.now() >= deadline) {
        const status = s.stage === 'expired_link' || daemonGone ? 'expired_link' : 'waiting'
        const payload = {
          status,
          id,
          revision: s.revision,
          draft: s.draft ?? null,
          formExpiresAt: s.formExpiresAt ?? null,
          expiresAt: s.expiresAt,
          next: status === 'waiting'
            ? `mp interaction wait --id ${id}`
            : `mp interaction ask --id ${id} --html <file>`,
        }
        // Exit 0: neither "they are still reading" nor "the link lapsed" is a
        // failure of this command, and a non-zero exit would end the turn
        // instead of letting the agent wait again or reopen.
        if (isJson()) emitJson(payload)
        else console.log(formatInteractionWait(s, payload))
        return
      }

      await new Promise((r) => setTimeout(r, 500))
    }
  }

  function status(args) {
    const parsed = parseArgs(args, 'interaction status')
    if (parsed.help) return console.log(renderCommandHelp('interaction status'))
    jsonFlag = Boolean(parsed.json)

    const all = state.listInteractions()
    const live = all.filter((s) => interactionHealth(s).active)
    for (const s of all) {
      const health = interactionHealth(s)
      if (health.active || s.error) continue
      // An answer nobody has read is not litter, even if the daemon that
      // collected it is gone — a reboot mid-question must not throw away
      // what the user already decided. `wait` still finds it; its TTL, and
      // `close`, still end it.
      if (isUnreadAnswer(s) && health.reason === 'stale') continue
      note(`${s.id}: previous question ${health.reason === 'expired' ? 'has expired' : 'is stale'}; cleaning up`)
      cleanupSlot(s)
    }

    const held = heldAnswers()

    if (isJson()) {
      return emitJson([...live, ...held].map((s) => ({
        id: s.id,
        purpose: s.purpose,
        stage: s.stage,
        revision: s.revision,
        url: s.stage === 'collecting' && s.tunnelUrl && s.sessionToken ? interactionUrl(s) : null,
        draftKeys: s.draft ? Object.keys(s.draft.answers || {}) : [],
        disposition: s.response?.disposition ?? null,
        deliveredAt: s.deliveredAt ?? null,
        expiresAt: s.expiresAt,
        expiresInMinutes: minutesLeft(s.expiresAt),
        daemonPid: s.daemonPid ?? null,
        daemonGone: !interactionHealth(s).active,
      })))
    }
    return console.log(formatInteractionStatus(live, Date.now(), held))
  }

  async function close(args) {
    const parsed = parseArgs(args, 'interaction close')
    if (parsed.help) return console.log(renderCommandHelp('interaction close'))

    async function closeOne(s) {
      if (s.daemonPid && isAlive(s.daemonPid) && s.ipcPath) {
        try {
          await ipcCall(s.ipcPath, { op: 'close' }, { connectTimeoutMs: 2_000 })
          // Give the daemon a moment to clear its own record and exit. One
          // that has cleared it has done the work — the process going away is
          // a formality — so only a slot still holding a record after the
          // grace gets killed by pid, which a reused pid would make dangerous.
          for (let i = 0; i < 20 && isAlive(s.daemonPid); i += 1) {
            await new Promise((r) => setTimeout(r, 50))
          }
          if (!state.readInteraction(s.id)) {
            note(`closed ${s.id}`)
            return
          }
        } catch {
          // Unreachable daemon: fall through to the kill below.
        }
      }
      cleanupSlot(s)
      note(`closed ${s.id}`)
    }

    if (parsed.all) {
      const all = state.listInteractions()
      if (!all.length) return note('no interaction to close')
      for (const s of all) await closeOne(s)
      return undefined
    }

    const id = resolveId(parsed)
    const s = state.readInteraction(id)
    if (!s) fail(`no interaction ${id}.`, { id })
    return closeOne({ ...s, id })
  }

  return {
    ask, wait, status, close,
  }
}
