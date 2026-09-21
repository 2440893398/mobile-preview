import { createServer as createNetServer } from 'node:net'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createFormServer } from './secret-form.js'
import { decryptSubmission, generateServerKeys } from './secret-crypto.js'
import { createScrubber } from './scrub.js'
import { findApprovedUse, spawnArgv } from './argv.js'
import { hashToken, mintToken } from './auth.js'
import { isAlive, killTree, startTunnel } from './tunnel.js'
import * as state from './state.js'

// The process that holds the values. Same skeleton as the preview daemon —
// detached, stdio discarded, TTL suicide, one state file it owns — but the
// opposite job: the preview daemon lets things out, this one keeps them in.
//
// Values live in `values` below and nowhere else. The state file gets names,
// lengths and fingerprints; the IPC protocol has no operation that returns a
// value; the tunnel is closed the moment the form is submitted.

export const SECRET_ID_RE = state.SECRET_ID_RE
export const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const FIELD_KINDS = ['secret', 'text', 'multiline']

export function mintSecretId() {
  return `s-${randomBytes(3).toString('hex')}`
}

// Enough for the user to tell "I pasted the wrong one" from the phone, not
// enough to help anyone guess the value.
export function fingerprint(value) {
  const v = String(value ?? '')
  return { length: v.length, sha256_8: createHash('sha256').update(v).digest('hex').slice(0, 8) }
}

export function secretHealth(s, now = Date.now()) {
  if (!s) return { active: false, reason: 'missing' }
  if (s.error) return { active: false, reason: 'error' }
  if (!s.daemonPid) return { active: false, reason: 'incomplete' }
  if (!s.expiresAt || now > s.expiresAt) return { active: false, reason: 'expired' }
  if (!isAlive(s.daemonPid)) return { active: false, reason: 'stale' }
  return { active: true, reason: 'active' }
}

export function clearOwnedSecret(id, pid = process.pid) {
  const s = state.readSecret(id)
  if (!s || s.daemonPid !== pid) return false
  state.clearSecret(id)
  return true
}

function send(sock, ev) {
  if (sock.destroyed || !sock.writable) return
  sock.write(`${JSON.stringify(ev)}\n`)
}

export async function runSecretDaemon({
  id,
  purpose,
  fields,
  uses = [],
  ttlMinutes = 120,
  formTtlMinutes = 10,
  startTunnelFn = startTunnel,
  spawnFn = spawn,
  ipcPath = state.secretIpcPath(id),
  // How long after the phone's submission the tunnel is torn down. The 200
  // has to cross the edge before cloudflared dies; 1.5s is generous for that
  // and still shorter than anyone can type a second request.
  closeDelayMs = 1_500,
  // Seam for tests: the real daemon exits the process on forget, TTL and a
  // form that expired unfilled; a test driving it in-process cannot let it.
  exitFn = (code) => process.exit(code),
  // The pid written to the record — the one `forget` kills if the daemon does
  // not answer in time. Always this process's own, except in a test running
  // the daemon inside the test runner: there it must name a stand-in, or a
  // slow `forget` under load kills the runner itself (seen 2026-09-21).
  ownerPid = process.pid,
}) {
  if (!SECRET_ID_RE.test(String(id))) throw new Error(`bad secret id ${JSON.stringify(id)}`)

  const values = new Map()
  let approvedUses = []
  let filled = false
  let form = null
  let ipc = null
  let disposed = false
  const createdAt = Date.now()
  const expiresAt = createdAt + ttlMinutes * 60_000
  const logPath = state.secretLogPath(id)

  const audit = (event, extra = {}) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`)
    } catch {
      // The audit log is a nicety on top of the state file; losing a line
      // must not fail the operation it describes.
    }
  }

  const patch = (p) => {
    try {
      return state.writeSecret(id, p)
    } catch {
      return null
    }
  }

  state.writeSecret(id, {
    id,
    purpose,
    daemonPid: ownerPid,
    createdAt,
    expiresAt,
    ttlMinutes,
    fields: fields.map(({ name, kind }) => ({ name, kind })),
    requestedUses: uses,
    uses: [],
    pendingUses: [],
    runs: 0,
    stage: 'starting',
    stageAt: createdAt,
    ipcPath,
    logPath,
    tunnelLogPath: state.secretTunnelLogPath(id),
  })

  function closeForm(reason) {
    if (!form) return
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
      tunnelUrl: null, tunnelPid: null, sessionToken: null, formPort: null,
      formExpiresAt: null, pendingUses: [], stage: filled ? 'filled' : 'starting', stageAt: Date.now(),
    })
    audit('form-closed', { reason, mode: f.mode })
  }

  function onSubmit({ values: v, uses: chosen }, mode) {
    if (mode === 'fill') {
      for (const [name, value] of Object.entries(v)) values.set(name, value)
      approvedUses = [...chosen]
      filled = true
      patch({
        stage: 'filled',
        stageAt: Date.now(),
        filledAt: Date.now(),
        fields: fields.map(({ name, kind }) => ({ name, kind, ...fingerprint(v[name]) })),
        uses: approvedUses,
        pendingUses: [],
        sessionToken: null,
      })
      audit('filled', { fields: fields.map((f) => f.name), uses: approvedUses })
    } else {
      approvedUses = [...new Set([...approvedUses, ...chosen])]
      patch({
        stage: 'filled', stageAt: Date.now(), uses: approvedUses, pendingUses: [], sessionToken: null,
      })
      audit('approved', { uses: chosen })
    }
    // Let the 200 reach the phone before the tunnel goes away.
    setTimeout(() => closeForm('submitted'), closeDelayMs).unref?.()
  }

  async function openForm({ mode, offeredUses }) {
    if (form) throw new Error('a form is already open')
    const keys = mode === 'fill' ? generateServerKeys() : null
    const sessionToken = mintToken()
    const formExpiresAt = Date.now() + formTtlMinutes * 60_000
    const names = fields.map((f) => f.name)

    const server = createFormServer({
      purpose,
      fields: mode === 'fill' ? fields : [],
      uses: offeredUses,
      mode,
      savedFields: names,
      sessionHash: hashToken(sessionToken),
      expiresAt: formExpiresAt,
      graceMs: formExpiresAt - Date.now(),
      publicJwk: keys?.publicJwk ?? null,
      decrypt: keys ? (p) => decryptSubmission(keys.privateKey, p, names) : null,
      onSubmit: (s) => onSubmit(s, mode),
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const formPort = server.address().port

    form = {
      server, mode, formPort, offeredUses, tunnelPid: null, expiryTimer: null,
    }
    patch({
      stage: 'starting', stageAt: Date.now(), formPort, formExpiresAt, pendingUses: offeredUses,
      tunnelUrl: null, tunnelPid: null, sessionToken: null, reopenError: null,
    })

    const t = await startTunnelFn(formPort, {
      logPath: state.secretTunnelLogPath(id),
      onProgress: ({ stage, attempt, tries }) => patch({
        stage: 'starting', tunnelStage: stage, attempt, tries, stageAt: Date.now(),
      }),
    })
    if (!form || form.server !== server) {
      // Closed (TTL, forget) while the tunnel was coming up.
      killTree(t.pid)
      return
    }
    form.tunnelPid = t.pid
    form.expiryTimer = setTimeout(() => onFormExpired(mode), Math.max(0, formExpiresAt - Date.now()))
    form.expiryTimer.unref?.()
    patch({
      stage: 'collecting', stageAt: Date.now(), tunnelUrl: t.url, tunnelPid: t.pid, sessionToken,
      tunnelStage: null, attempt: null, tries: null,
    })
    audit('form-opened', { mode, uses: offeredUses })
  }

  function onFormExpired(mode) {
    if (mode === 'fill' && !filled) {
      audit('form-expired', { mode })
      closeForm('expired')
      patch({
        stage: 'expired',
        error: `the form link expired after ${formTtlMinutes} min without a submission. Run \`mp secret ask\` again.`,
      })
      exitOnShutdown(1)
      return
    }
    audit('approval-expired', { mode })
    closeForm('expired')
  }

  function handleRun(req, sock) {
    if (!filled) return send(sock, { type: 'error', code: 'not-filled', error: 'nothing has been filled in yet — run `mp secret wait` first' })
    const argv = Array.isArray(req.argv) ? req.argv : null
    if (!argv || !argv.length || argv.some((a) => typeof a !== 'string')) {
      return send(sock, { type: 'error', code: 'bad-argv', error: 'argv must be a non-empty list of strings' })
    }
    const use = findApprovedUse(approvedUses, argv)
    if (!use) {
      audit('denied', { argv })
      return send(sock, {
        type: 'error',
        code: 'not-approved',
        error: `that command is not among the uses approved on the phone. Approved: ${
          approvedUses.length ? approvedUses.map((u) => JSON.stringify(u)).join(', ') : '(none)'
        }. Ask for it with \`mp secret ask --id ${id} --use ${JSON.stringify(argv.join(' '))}\`.`,
      })
    }

    const env = { ...process.env }
    for (const [name, value] of values) env[name] = value
    // Only the secret-kind fields are scrubbed from the output. A `text`
    // field — a bucket name, an endpoint — is there precisely because it is
    // fine to see, and redacting it would make every log line unreadable.
    const secrets = fields
      .filter((f) => f.kind !== 'text' && values.has(f.name))
      .map((f) => ({ name: f.name, value: values.get(f.name) }))

    let child
    try {
      child = spawnArgv(argv, { cwd: req.cwd || undefined, env, spawnFn })
    } catch (err) {
      audit('spawn-failed', { argv, error: String(err?.message || err) })
      return send(sock, { type: 'error', code: 'spawn-failed', error: String(err?.message || err) })
    }
    const startedAt = Date.now()
    patch((cur) => ({ runs: (cur.runs || 0) + 1, lastRunAt: startedAt }))

    const pipe = (stream, type) => {
      if (!stream) return
      const scrub = createScrubber(secrets)
      const decoder = new StringDecoder('utf8')
      stream.on('data', (d) => {
        const out = scrub.push(decoder.write(d))
        if (out) send(sock, { type, data: out })
      })
      stream.on('end', () => {
        const out = scrub.push(decoder.end()) + scrub.flush()
        if (out) send(sock, { type, data: out })
      })
    }
    pipe(child.stdout, 'stdout')
    pipe(child.stderr, 'stderr')

    let done = false
    child.on('error', (err) => {
      if (done) return
      done = true
      audit('run', { argv, use, error: String(err?.message || err) })
      send(sock, { type: 'error', code: 'spawn-failed', error: String(err?.message || err) })
    })
    child.on('close', (code, signal) => {
      if (done) return
      done = true
      audit('run', { argv, use, code, signal, ms: Date.now() - startedAt })
      send(sock, { type: 'exit', code, signal })
    })
    // The CLI going away mid-run must not leave the child running with the
    // values in its environment.
    sock.on('close', () => {
      if (!done && child.pid) killTree(child.pid)
    })
  }

  function statusPayload() {
    return {
      type: 'status',
      id,
      purpose,
      stage: form ? 'collecting' : filled ? 'filled' : 'starting',
      fields: fields.map(({ name, kind }) => ({
        name, kind, ...(values.has(name) ? fingerprint(values.get(name)) : {}),
      })),
      uses: approvedUses,
      pendingUses: form ? form.offeredUses : [],
      expiresAt,
    }
  }

  async function handleReopen(req, sock) {
    if (!filled) return send(sock, { type: 'error', code: 'not-filled', error: 'nothing has been filled in yet' })
    if (form) return send(sock, { type: 'error', code: 'form-open', error: 'a form link is already open for this slot; wait for it or let it expire' })
    const offered = Array.isArray(req.uses) ? req.uses.filter((u) => typeof u === 'string' && u.trim()) : []
    if (!offered.length) return send(sock, { type: 'error', code: 'bad-uses', error: 'no uses to approve' })
    const fresh = offered.filter((u) => !approvedUses.includes(u))
    if (!fresh.length) return send(sock, { type: 'ok', alreadyApproved: true })

    send(sock, { type: 'ok' })
    try {
      await openForm({ mode: 'approve', offeredUses: fresh })
    } catch (err) {
      closeForm('tunnel-failed')
      patch({ reopenError: String(err?.message || err), stage: 'filled', stageAt: Date.now() })
      audit('reopen-failed', { error: String(err?.message || err) })
    }
  }

  function handle(req, sock) {
    switch (req?.op) {
      case 'status': return send(sock, statusPayload())
      case 'run': return handleRun(req, sock)
      case 'reopen': return handleReopen(req, sock)
      case 'forget':
        send(sock, { type: 'ok' })
        sock.end()
        audit('forget')
        setImmediate(() => exitOnShutdown(0))
        return undefined
      default:
        // Deliberately the whole surface: there is no `get`, and a request
        // for one is answered the same way as any other typo.
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
        if (buf.length > 1_000_000) sock.destroy()
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
    values.clear()
    approvedUses = []
    try {
      ipc.close()
    } catch {
      // already closed
    }
    if (process.platform !== 'win32') rmSync(ipcPath, { force: true })
    clearOwnedSecret(id, ownerPid)
  }

  const exitOnShutdown = (code = 0) => {
    // A record that ended in an error is left for `mp secret wait` and
    // `status` to read and report; a clean end leaves nothing.
    if (code === 0) shutdown()
    else {
      closeForm('shutdown')
      values.clear()
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
    values.clear()
    try {
      ipc.close()
    } catch {
      // already closed
    }
    if (process.platform !== 'win32') rmSync(ipcPath, { force: true })
    state.clearSecret(id)
  }

  try {
    await openForm({ mode: 'fill', offeredUses: uses })
  } catch (err) {
    audit('tunnel-failed', { error: String(err?.message || err) })
    // Close first: closeForm rewrites `stage`, and the failure written below
    // has to be the last word on the record.
    closeForm('tunnel-failed')
    patch({
      error: String(err?.message || err),
      errorReason: err?.reason || 'unknown',
      logPath: state.secretTunnelLogPath(id),
      stage: 'failed',
      stageAt: Date.now(),
    })
    exitOnShutdown(1)
  }

  return {
    id, ipcPath, shutdown, dispose, formPort: () => form?.formPort ?? null,
  }
}
