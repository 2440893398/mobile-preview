import { createServer as createNetServer } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInteractionServer } from './interaction-form.js'
import { checkPage, contentDigest } from './interaction-page.js'
import { hashToken, mintToken } from './auth.js'
import { isAlive, killTree, startTunnel } from './tunnel.js'
import * as state from './state.js'

// The process that owns one question. Same skeleton as the secret daemon —
// detached, TTL suicide, one state file it owns — with one deliberate
// difference: what arrives here is meant to be read.
//
// The secret daemon keeps values in memory precisely so nothing can print
// them. An answer is the opposite: the entire point is for `mp interaction
// wait` to hand it to the agent, so it goes in the state file, survives this
// process, and can be re-read after a context compaction lost the first copy.
//
// The daemon outlives the answer on purpose. The link closes the moment it is
// submitted, but the record stays until its TTL or `mp interaction close`, so
// a `wait` that arrives late still finds it instead of "that is gone".

export const INTERACTION_ID_RE = state.INTERACTION_ID_RE

export function mintInteractionId() {
  return `i-${randomBytes(3).toString('hex')}`
}

export function interactionHealth(s, now = Date.now()) {
  if (!s) return { active: false, reason: 'missing' }
  if (s.error) return { active: false, reason: 'error' }
  if (!s.daemonPid) return { active: false, reason: 'incomplete' }
  if (!s.expiresAt || now > s.expiresAt) return { active: false, reason: 'expired' }
  if (!isAlive(s.daemonPid)) return { active: false, reason: 'stale' }
  return { active: true, reason: 'active' }
}

export function clearOwnedInteraction(id, pid = process.pid) {
  const s = state.readInteraction(id)
  if (!s || s.daemonPid !== pid) return false
  state.clearInteraction(id)
  return true
}

function send(sock, ev) {
  if (sock.destroyed || !sock.writable) return
  sock.write(`${JSON.stringify(ev)}\n`)
}

export async function runInteractionDaemon({
  id,
  purpose,
  html,
  ttlMinutes = 120,
  formTtlMinutes = 30,
  startTunnelFn = startTunnel,
  ipcPath = state.interactionIpcPath(id),
  // Long enough for the 200 to cross the edge and the receipt to render
  // before cloudflared goes away — and long enough to outlast the page
  // retrying on its own. A receipt lost to a reconnect brings the phone
  // back with the same responseId half a minute later; a door already shut
  // would tell someone their answer failed after it had arrived.
  closeDelayMs = 45_000,
  exitFn = (code) => process.exit(code),
  // The pid written to the record — the one `close` kills if the daemon does
  // not answer in time. Always this process's own, except in a test running
  // the daemon inside the test runner: there it must name a stand-in, or a
  // slow `close` under load kills the runner itself (seen 2026-09-21).
  ownerPid = process.pid,
}) {
  if (!INTERACTION_ID_RE.test(String(id))) throw new Error(`bad interaction id ${JSON.stringify(id)}`)
  const first = checkPage(html)
  if (!first.ok) throw new Error(`the page does not meet the interaction contract: ${first.problems.join('; ')}`)

  let page = String(html)
  let digest = contentDigest(page)
  let revision = 1
  let response = null
  // Kept here as well as in the state file so a reopened page can be served
  // with it: the phone's own copy is in localStorage, which a different
  // browser — the in-app one, then Safari — does not share.
  let draft = null
  const receipts = new Map()
  let form = null
  let ipc = null
  let disposed = false
  const createdAt = Date.now()
  const expiresAt = createdAt + ttlMinutes * 60_000
  const logPath = state.interactionLogPath(id)

  const audit = (event, extra = {}) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`)
    } catch {
      // The audit log is a nicety on top of the state file.
    }
  }

  const patch = (p) => {
    try {
      return state.writeInteraction(id, p)
    } catch {
      return null
    }
  }

  state.writeInteraction(id, {
    id,
    purpose,
    daemonPid: ownerPid,
    createdAt,
    expiresAt,
    ttlMinutes,
    revision,
    contentDigest: digest,
    pageBytes: first.bytes,
    warnings: first.warnings,
    stage: 'starting',
    stageAt: createdAt,
    draft: null,
    response: null,
    history: [],
    ipcPath,
    logPath,
    tunnelLogPath: state.interactionTunnelLogPath(id),
  })

  // `only` pins the close to one particular form. Without it a close
  // scheduled for the form that was just answered would fire after a re-ask
  // had already opened the next one, and tear that one down instead — the
  // user would be handed a link that dies a second and a half later.
  function closeForm(reason, only = null) {
    if (!form || (only && form !== only)) return
    const f = form
    form = null
    clearTimeout(f.expiryTimer)
    try {
      f.server.close()
    } catch {
      // already closed
    }
    if (f.tunnelPid) killTree(f.tunnelPid)
    patch({
      tunnelUrl: null, tunnelPid: null, sessionToken: null, formPort: null, formExpiresAt: null,
    })
    audit('form-closed', { reason, revision: f.revision })
  }

  function onDraft({ answers }) {
    if (response) return
    draft = { answers, revision, savedAt: Date.now() }
    patch({ draft })
  }

  function onSubmit({ responseId, disposition, answers, reason }) {
    // Idempotent on responseId, not on "a submission happened": a phone that
    // retried through a flaky tunnel must get its own receipt back, not a
    // second one that would look like a second answer to the agent.
    const seen = receipts.get(responseId)
    if (seen) return { receiptId: seen, duplicate: true }
    // A different responseId after the question is answered is a stale tab,
    // not a retry. The agent may already have acted on the first answer.
    if (response) return { conflict: true }

    const receiptId = randomUUID()
    receipts.set(responseId, receiptId)
    draft = null
    response = {
      receiptId, responseId, disposition, answers, reason, revision, receivedAt: Date.now(),
    }
    patch({
      stage: 'submitted', stageAt: Date.now(), response, draft: null, sessionToken: null,
    })
    audit('submitted', { disposition, responseId, receiptId, keys: Object.keys(answers) })
    // Let the 200 reach the phone and the receipt render before the tunnel
    // goes away — but only ever close the form this answer came from.
    const answered = form
    setTimeout(() => closeForm('submitted', answered), closeDelayMs).unref?.()
    return { receiptId, duplicate: false }
  }

  async function openForm() {
    if (form) throw new Error('a link is already open')
    const sessionToken = mintToken()
    const formExpiresAt = Date.now() + formTtlMinutes * 60_000
    const thisRevision = revision

    const server = createInteractionServer({
      html: page,
      requestId: id,
      revision: thisRevision,
      contentDigest: digest,
      sessionHash: hashToken(sessionToken),
      expiresAt: formExpiresAt,
      graceMs: formExpiresAt - Date.now(),
      draft: () => draft,
      onDraft,
      onSubmit,
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const formPort = server.address().port

    form = {
      server, formPort, revision: thisRevision, tunnelPid: null, expiryTimer: null,
    }
    patch({
      stage: 'starting', stageAt: Date.now(), formPort, formExpiresAt,
      tunnelUrl: null, tunnelPid: null, sessionToken: null, reopenError: null,
    })

    const t = await startTunnelFn(formPort, {
      logPath: state.interactionTunnelLogPath(id),
      onProgress: ({ stage, attempt, tries }) => patch({
        stage: 'starting', tunnelStage: stage, attempt, tries, stageAt: Date.now(),
      }),
    })
    if (!form || form.server !== server) {
      // Closed (TTL, close) while the tunnel was coming up.
      killTree(t.pid)
      return
    }
    form.tunnelPid = t.pid
    form.expiryTimer = setTimeout(onFormExpired, Math.max(0, formExpiresAt - Date.now()))
    form.expiryTimer.unref?.()
    patch({
      stage: 'collecting', stageAt: Date.now(), tunnelUrl: t.url, tunnelPid: t.pid, sessionToken,
      tunnelStage: null, attempt: null, tries: null,
    })
    audit('form-opened', { revision: thisRevision })
  }

  // An expired link is not a failure — unlike the secret form, whose whole
  // purpose has passed by then. Whatever was typed is still worth having, and
  // the agent can reopen the same question. So the record stays and the
  // daemon lives on; only the door closes.
  function onFormExpired() {
    if (response) return closeForm('expired')
    audit('link-expired', { revision })
    closeForm('expired')
    return patch({ stage: 'expired_link', stageAt: Date.now() })
  }

  function statusPayload() {
    return {
      type: 'status',
      id,
      purpose,
      revision,
      stage: response ? 'submitted' : form ? 'collecting' : 'expired_link',
      expiresAt,
    }
  }

  // The re-ask: the user said the question itself was wrong, the agent wrote
  // a new page. Same id so the conversation keeps one thread, new revision so
  // a tab still showing the old one cannot answer it.
  async function handleReopen(req, sock) {
    const next = typeof req.html === 'string' ? req.html : null
    if (!next) return send(sock, { type: 'error', code: 'bad-html', error: 'reopen needs an html string' })
    const verdict = checkPage(next)
    if (!verdict.ok) {
      return send(sock, { type: 'error', code: 'bad-page', error: verdict.problems.join('; '), problems: verdict.problems })
    }
    // The guard is for someone who is still answering — not for the second
    // and a half between their submission and the tunnel going down, which
    // is exactly when an agent that just read the answer comes back with the
    // next version of the question.
    if (form && !response) {
      return send(sock, {
        type: 'error',
        code: 'form-open',
        error: `a link is already open for ${id}; wait for it with \`mp interaction wait --id ${id}\` or let it expire`,
      })
    }

    send(sock, { type: 'ok', revision: revision + 1 })
    if (response) {
      closeForm('superseded')
      patch((cur) => ({ history: [...(cur.history || []), response] }))
      response = null
    }
    page = next
    const nextDigest = contentDigest(page)
    // The same page again — a link that lapsed while they were thinking, sent
    // back out. What they had typed is still an answer to this exact
    // question, so it survives; a different page makes it answers to a
    // question nobody asked.
    if (nextDigest !== digest) draft = null
    digest = nextDigest
    revision += 1
    patch({
      revision,
      contentDigest: digest,
      pageBytes: verdict.bytes,
      warnings: verdict.warnings,
      response: null,
      draft,
      stage: 'starting',
      stageAt: Date.now(),
      // Cleared here rather than in openForm: the `ok` above has already let
      // `mp interaction ask` start watching this record, and a failure left
      // over from the previous attempt would be read as this one's.
      reopenError: null,
    })
    audit('reopened', { revision })
    try {
      await openForm()
    } catch (err) {
      closeForm('tunnel-failed')
      patch({ reopenError: String(err?.message || err), stage: 'expired_link', stageAt: Date.now() })
      audit('reopen-failed', { error: String(err?.message || err) })
    }
    return undefined
  }

  function handle(req, sock) {
    switch (req?.op) {
      case 'status': return send(sock, statusPayload())
      case 'reopen': return handleReopen(req, sock)
      case 'close':
        send(sock, { type: 'ok' })
        sock.end()
        audit('closed')
        setImmediate(() => exitOnShutdown(0))
        return undefined
      default:
        return send(sock, { type: 'error', code: 'unknown-op', error: `unknown op ${JSON.stringify(req?.op)}` })
    }
  }

  ipc = createNetServer((sock) => {
    let buf = ''
    let handled = false
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    sock.on('data', (d) => {
      if (handled) return
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) {
        // A reopen carries a whole page, so the ceiling is the page limit
        // with room for JSON escaping, not the secret daemon's 1 MB.
        if (buf.length > 2_000_000) sock.destroy()
        return
      }
      handled = true
      let req
      try {
        req = JSON.parse(buf.slice(0, nl))
      } catch {
        send(sock, { type: 'error', code: 'bad-request', error: 'request is not JSON' })
        sock.end()
        return
      }
      handle(req, sock)
    })
  })
  if (process.platform !== 'win32' && existsSync(ipcPath)) rmSync(ipcPath, { force: true })
  await new Promise((resolve, reject) => {
    ipc.once('error', reject)
    ipc.listen(ipcPath, resolve)
  })

  const shutdown = () => {
    if (disposed) return
    closeForm('shutdown')
    try {
      ipc.close()
    } catch {
      // already closed
    }
    if (process.platform !== 'win32') rmSync(ipcPath, { force: true })
    clearOwnedInteraction(id, ownerPid)
  }

  const exitOnShutdown = (code = 0) => {
    // A record that ended in an error is left behind for `wait` to read and
    // report; a clean end leaves nothing.
    if (code === 0) shutdown()
    else {
      closeForm('shutdown')
      try {
        ipc.close()
      } catch {
        // already closed
      }
    }
    exitFn(code)
  }

  const ttlTimer = setTimeout(() => {
    audit('expired')
    exitOnShutdown(0)
  }, Math.max(0, expiresAt - Date.now()))
  ttlTimer.unref?.()
  const pollTimer = setInterval(() => {
    if (Date.now() >= expiresAt) exitOnShutdown(0)
  }, 15_000)
  pollTimer.unref?.()
  const onSignal = () => exitOnShutdown(0)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const dispose = () => {
    disposed = true
    clearTimeout(ttlTimer)
    clearInterval(pollTimer)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    closeForm('dispose')
    try {
      ipc.close()
    } catch {
      // already closed
    }
    if (process.platform !== 'win32') rmSync(ipcPath, { force: true })
    state.clearInteraction(id)
  }

  try {
    await openForm()
  } catch (err) {
    audit('tunnel-failed', { error: String(err?.message || err) })
    // Close first: closeForm rewrites the link fields, and the failure
    // written below has to be the last word on the record.
    closeForm('tunnel-failed')
    patch({
      error: String(err?.message || err),
      errorReason: err?.reason || 'unknown',
      logPath: state.interactionTunnelLogPath(id),
      stage: 'failed',
      stageAt: Date.now(),
    })
    exitOnShutdown(1)
  }

  return {
    id, ipcPath, shutdown, dispose, formPort: () => form?.formPort ?? null,
  }
}
