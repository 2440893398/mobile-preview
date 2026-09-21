import { createServer as createNetServer } from 'node:net'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, rmSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { FormError, PASSPHRASE_FIELD, createFormServer } from './secret-form.js'
import { decryptSubmission, generateServerKeys } from './secret-crypto.js'
import { createScrubber, scrubText } from './scrub.js'
import { findApprovedUse, spawnArgv } from './argv.js'
import { hashToken, mintToken } from './auth.js'
import { isAlive, killTree, startTunnel } from './tunnel.js'
import {
  MAX_PASSPHRASE_FAILURES, PassphraseError, appliesTo, fileKey, fingerprint, projectId, removeSaved,
  strictestLevel, vaultAudit,
} from './secret-vault.js'
import {
  gitProblem, isInside, knownRenderedPaths, recordKept, removeRendered, renderTemplate, samePath,
  writeRendered,
} from './secret-render.js'
import * as state from './state.js'

// The process that holds the values. Same skeleton as the preview daemon —
// detached, stdio discarded, TTL suicide, one state file it owns — but the
// opposite job: the preview daemon lets things out, this one keeps them in.
//
// Values live in `values` below and, when the user chose to save them, as
// ciphertext in the vault (secret-vault.js). The state file gets names,
// lengths and fingerprints; the IPC protocol has no operation that returns a
// value; the tunnel is closed the moment the form is submitted.
//
// A daemon started in a project with saved values may never open a tunnel at
// all: at the "auto" level it decrypts them and is filled from the start
// (2026-09-21 vault design §5.2).

export { fingerprint }
export const SECRET_ID_RE = state.SECRET_ID_RE
// `__mp_` is reserved for what rides the form's encrypted channel alongside
// the fields — the vault passphrase.
export const FIELD_NAME_RE = /^(?!__mp_)[A-Za-z_][A-Za-z0-9_]*$/
export const FIELD_KINDS = ['secret', 'text', 'multiline']

export function mintSecretId() {
  return `s-${randomBytes(3).toString('hex')}`
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

const plainFile = ({ template, out, keep }) => ({ template, out, keep: Boolean(keep) })
const sameFile = (a, b) => samePath(a.template, b.template) && samePath(a.out, b.out) && Boolean(a.keep) === Boolean(b.keep)
const unionFiles = (a, b) => [...a, ...b.filter((f) => !a.some((x) => sameFile(x, f)))]

export async function runSecretDaemon({
  id,
  purpose,
  fields,
  uses = [],
  // Render targets the AI declared: [{ template, out, keep }], absolute paths.
  renders = [],
  // The project whose saved values apply, or null to neither read nor save.
  projectRoot = null,
  // Ignore saved values for these fields and ask for them afresh.
  refill = false,
  // createVault(...) — null means saving is unavailable, as it is without a
  // system keystore.
  vault = null,
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
  const names = fields.map((f) => f.name)
  let approvedUses = []
  let approvedFiles = []
  let filled = false
  // Every field of this slot is saved in the vault, so approvals given for
  // it are worth remembering there too.
  let persisted = false
  let form = null
  let ipc = null
  let disposed = false
  let saveAvailable = false
  let saved = {}
  let remembered = { uses: [], files: [] }
  let passphraseFailures = 0
  const rendered = []
  const createdAt = Date.now()
  const expiresAt = createdAt + ttlMinutes * 60_000
  const logPath = state.secretLogPath(id)
  const pid = projectRoot ? projectId(projectRoot) : null

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
    projectRoot,
    fields: fields.map(({ name, kind }) => ({ name, kind })),
    requestedUses: uses,
    uses: [],
    files: [],
    pendingUses: [],
    pendingFiles: [],
    renderedFiles: [],
    runs: 0,
    stage: 'starting',
    stageAt: createdAt,
    ipcPath,
    logPath,
    tunnelLogPath: state.secretTunnelLogPath(id),
  })

  // Only the secret kinds are scrubbed. A `text` field — a bucket name, an
  // endpoint — is there precisely because it is fine to see, and redacting it
  // would make every log line unreadable.
  const secretsForScrub = () => fields
    .filter((f) => f.kind !== 'text' && values.has(f.name))
    .map((f) => ({ name: f.name, value: values.get(f.name) }))

  // ---- the vault ----

  async function prepareVault() {
    if (!vault || !projectRoot) return
    saveAvailable = await vault.available()
    if (!saveAvailable) return

    let view
    try {
      view = vault.view(projectRoot)
    } catch (err) {
      view = { corrupt: true, error: err }
    }
    if (view.corrupt) {
      saveAvailable = false
      patch({ vaultError: `the saved values for this project are unreadable (${state.vaultProjectPath(pid)}); \`mp secret forget --saved\` clears them` })
      return
    }
    for (const f of fields) if (view.fields[f.name]) saved[f.name] = view.fields[f.name]
    if (!Object.keys(saved).length && !view.uses.length && !view.files.length) return

    try {
      await vault.loadKey()
    } catch (err) {
      audit('vault-key-failed', { error: String(err?.message || err) })
      saved = {}
      saveAvailable = false
      patch({ vaultError: `could not open the vault key: ${err?.message || err}` })
      return
    }
    const l = vault.lists(projectRoot)
    remembered = {
      uses: [...new Set(l.uses.filter((e) => appliesTo(e, names)).map((e) => e.use))],
      files: unionFiles([], l.files.filter((e) => appliesTo(e, names)).map(plainFile)),
    }
  }

  // Approvals given for a slot whose values are all saved are remembered
  // with the fields they cover. On a fill or confirm page every applicable
  // remembered entry was on offer, so the ones left unticked are dropped.
  function rememberApprovals(chosenUses, chosenFiles, { replaceApplicable }) {
    try {
      const cur = vault.lists(projectRoot)
      let u = cur.ok ? cur.uses : []
      let f = cur.ok ? cur.files : []
      if (replaceApplicable) {
        u = u.filter((e) => !appliesTo(e, names) || chosenUses.includes(e.use))
        f = f.filter((e) => !appliesTo(e, names) || chosenFiles.some((c) => sameFile(c, e)))
      }
      for (const use of chosenUses) {
        if (!u.some((e) => e.use === use && appliesTo(e, names))) u = [...u, { use, fields: [...names] }]
      }
      for (const c of chosenFiles) {
        if (!f.some((e) => sameFile(e, c) && appliesTo(e, names))) f = [...f, { ...c, fields: [...names] }]
      }
      vault.setLists(projectRoot, { uses: u, files: f })
    } catch (err) {
      audit('remember-failed', { error: String(err?.message || err) })
    }
  }

  const fileForForm = (f, isNew) => ({
    ...plainFile(f), key: fileKey(f), outside: !isInside(projectRoot, f.out), isNew,
  })

  // ---- the form ----

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
      tunnelUrl: null,
      tunnelPid: null,
      sessionToken: null,
      formPort: null,
      formExpiresAt: null,
      pendingUses: [],
      pendingFiles: [],
      formMode: null,
      formLevel: null,
      stage: filled ? 'filled' : 'starting',
      stageAt: Date.now(),
    })
    audit('form-closed', { reason, mode: f.mode })
  }

  const scheduleClose = () => {
    // Let the 200 reach the phone before the tunnel goes away.
    setTimeout(() => closeForm('submitted'), closeDelayMs).unref?.()
  }

  function holdValues(all, { uses: u, files: fl, source, level }) {
    for (const [name, value] of Object.entries(all)) values.set(name, value)
    approvedUses = [...u]
    approvedFiles = [...fl]
    filled = true
    return {
      filledAt: Date.now(),
      fields: fields.map(({ name, kind }) => ({ name, kind, ...fingerprint(all[name]) })),
      uses: approvedUses,
      files: approvedFiles,
      source,
      level: level ?? null,
    }
  }

  async function unlockFor(sub) {
    const needKp = sub.keep.some((n) => saved[n]?.level === 'passphrase') || sub.save?.level === 'passphrase'
    try {
      await vault.loadKey({ create: Boolean(sub.save) })
      return needKp ? await vault.unlock(sub.passphrase ?? '', { create: sub.save?.level === 'passphrase' }) : null
    } catch (err) {
      if (err instanceof PassphraseError) {
        passphraseFailures += 1
        audit('passphrase-failed', { attempt: passphraseFailures })
        const left = MAX_PASSPHRASE_FAILURES - passphraseFailures
        if (left <= 0) {
          setTimeout(() => closeForm('passphrase-lockout'), closeDelayMs).unref?.()
          throw new FormError(`主密码错了 ${MAX_PASSPHRASE_FAILURES} 次，这条链接已经失效。`, { closeForm: true })
        }
        throw new FormError(`${err.message}（还能再试 ${left} 次）`)
      }
      audit('vault-failed', { error: String(err?.message || err) })
      throw new FormError(`本机钥匙串出错：${err?.message || err}`)
    }
  }

  async function onSubmit(sub, mode, offeredFiles) {
    const chosenFiles = offeredFiles.filter((f) => sub.files.includes(f.key)).map(plainFile)

    if (mode === 'approve') {
      approvedUses = [...new Set([...approvedUses, ...sub.uses])]
      approvedFiles = unionFiles(approvedFiles, chosenFiles)
      if (persisted) rememberApprovals(sub.uses, chosenFiles, { replaceApplicable: false })
      patch({
        stage: 'filled', stageAt: Date.now(), uses: approvedUses, files: approvedFiles, pendingUses: [], pendingFiles: [], sessionToken: null,
      })
      audit('approved', { uses: sub.uses, files: chosenFiles.map((f) => f.out) })
      scheduleClose()
      return
    }

    let Kp = null
    const all = { ...sub.values }
    try {
      if (sub.keep.length || sub.save) Kp = await unlockFor(sub)
      if (sub.keep.length) {
        const { values: kv, failed } = vault.openFields(projectRoot, sub.keep, { Kp })
        if (failed.length) throw new FormError(`${failed.join('、')} 的保存记录校验没通过，请点「重新填写」。`)
        Object.assign(all, kv)
      }
      if (sub.save) {
        vault.save(projectRoot, fields.map((f) => ({ name: f.name, kind: f.kind, value: all[f.name] })), {
          level: sub.save.level, days: sub.save.days, Kp,
        })
        persisted = true
      } else if (vault && projectRoot) {
        // Retyping a saved field without saving it again means the old
        // value is not wanted any more.
        const dropped = names.filter((n) => saved[n] && !sub.keep.includes(n))
        if (dropped.length) removeSaved(projectRoot, dropped)
        if (sub.keep.length) vault.touch(projectRoot, sub.keep)
        persisted = sub.keep.length === names.length
      }
    } finally {
      Kp?.fill(0)
    }

    if (sub.keep.length) {
      vaultAudit('used', {
        pid, root: projectRoot, fields: sub.keep, slot: id, how: mode,
      })
    }
    if (persisted) rememberApprovals(sub.uses, chosenFiles, { replaceApplicable: true })

    const source = sub.keep.length === names.length ? 'saved' : 'form'
    const level = sub.save?.level ?? (sub.keep.length ? strictestLevel(sub.keep.map((n) => saved[n].level)) : null)
    patch({
      ...holdValues(all, {
        uses: sub.uses, files: chosenFiles, source, level,
      }),
      stage: 'filled',
      stageAt: Date.now(),
      pendingUses: [],
      pendingFiles: [],
      sessionToken: null,
      savedAs: sub.save ?? null,
    })
    audit('filled', {
      fields: names, uses: sub.uses, files: chosenFiles.map((f) => f.out), source, saved: sub.save?.level ?? null,
    })
    scheduleClose()
  }

  async function openForm({
    mode, offeredUses, offeredFiles = [], newUses = null,
  }) {
    if (form) throw new Error('a form is already open')
    const keys = mode === 'approve' ? null : generateServerKeys()
    const sessionToken = mintToken()
    const formExpiresAt = Date.now() + formTtlMinutes * 60_000
    let passphraseSet = false
    try {
      passphraseSet = saveAvailable && vault.hasPassphrase()
    } catch {
      passphraseSet = false
    }

    const server = createFormServer({
      purpose,
      projectRoot,
      fields: mode === 'approve' ? [] : fields,
      saved: mode === 'approve' ? {} : saved,
      uses: offeredUses,
      newUses,
      files: offeredFiles,
      mode,
      refill,
      save: { available: saveAvailable, passphraseSet },
      savedFields: names,
      sessionHash: hashToken(sessionToken),
      expiresAt: formExpiresAt,
      graceMs: formExpiresAt - Date.now(),
      publicJwk: keys?.publicJwk ?? null,
      decrypt: keys ? (p, expected) => decryptSubmission(keys.privateKey, p, expected, { optional: [PASSPHRASE_FIELD] }) : null,
      onSubmit: (s) => onSubmit(s, mode, offeredFiles),
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const formPort = server.address().port

    form = {
      server, mode, formPort, offeredUses, offeredFiles, tunnelPid: null, expiryTimer: null,
    }
    patch({
      stage: 'starting',
      stageAt: Date.now(),
      formPort,
      formExpiresAt,
      formMode: mode,
      // What the confirm page will ask of the user — one tap, or the
      // passphrase — so `ask` can tell the AI which it is handing over.
      formLevel: mode === 'confirm' ? strictestLevel(names.map((n) => saved[n]?.level).filter(Boolean)) : null,
      pendingUses: offeredUses,
      pendingFiles: offeredFiles.map(plainFile),
      tunnelUrl: null,
      tunnelPid: null,
      sessionToken: null,
      reopenError: null,
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
    audit('form-opened', { mode, uses: offeredUses, files: offeredFiles.map((f) => f.out) })
  }

  function onFormExpired(mode) {
    if (mode !== 'approve' && !filled) {
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

  // ---- render ----

  function matchApproved(renders) {
    const out = []
    for (const r of renders) {
      if (!r || typeof r.template !== 'string' || typeof r.out !== 'string') {
        return { error: { code: 'bad-render', error: 'each render target needs a template and an output path' } }
      }
      const ap = approvedFiles.find((f) => samePath(f.template, r.template) && samePath(f.out, r.out))
      if (!ap) {
        return {
          error: {
            code: 'not-approved',
            error: `writing ${r.out} from ${r.template} is not among the render targets approved on the phone. `
              + `Ask for it with \`mp secret ask --id ${id} --render "${r.template}=${r.out}"\`.`,
          },
        }
      }
      out.push(ap)
    }
    return { matched: out }
  }

  function renderOne(ap, lifetime) {
    let tpl
    try {
      tpl = readFileSync(ap.template, 'utf8')
    } catch (err) {
      throw new Error(`cannot read the template ${ap.template}: ${err.code || err.message}`)
    }
    const content = renderTemplate(tpl, Object.fromEntries(values))
    const problem = gitProblem(ap.out)
    if (problem) throw new Error(problem)
    if (existsSync(ap.out) && !knownRenderedPaths().some((p) => samePath(p, ap.out))) {
      throw new Error(`${ap.out} already exists and was not written by mp. Refusing to overwrite a file someone wrote by hand — move it away first.`)
    }
    const rec = {
      path: ap.out, template: ap.template, lifetime, sha256_8: writeRendered(ap.out, content), renderedAt: Date.now(),
    }
    if (lifetime === 'keep') {
      recordKept({ ...rec, project: projectRoot })
    } else {
      const i = rendered.findIndex((r) => samePath(r.path, rec.path))
      if (i >= 0) rendered.splice(i, 1)
      rendered.push(rec)
      patch({ renderedFiles: rendered.map((r) => ({ ...r })) })
    }
    audit('rendered', { out: ap.out, template: ap.template, lifetime })
    return rec
  }

  function unrender(rec, reason) {
    removeRendered(rec.path)
    const i = rendered.findIndex((r) => samePath(r.path, rec.path))
    if (i >= 0) rendered.splice(i, 1)
    patch({ renderedFiles: rendered.map((r) => ({ ...r })) })
    audit('unrendered', { out: rec.path, reason })
  }

  function unrenderAll(reason) {
    for (const r of [...rendered]) {
      removeRendered(r.path)
      audit('unrendered', { out: r.path, reason })
    }
    rendered.length = 0
  }

  function renderAll(matched, lifetimeOf) {
    const made = []
    try {
      for (const ap of matched) made.push(renderOne(ap, lifetimeOf(ap)))
      return { made }
    } catch (err) {
      for (const m of made) if (m.lifetime === 'run') unrender(m, 'render-failed')
      return { error: String(err?.message || err) }
    }
  }

  // ---- IPC operations ----

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
    const m = matchApproved(Array.isArray(req.renders) ? req.renders : [])
    if (m.error) {
      audit('denied', { argv, renders: req.renders })
      return send(sock, { type: 'error', ...m.error })
    }
    const r = renderAll(m.matched, (ap) => (ap.keep ? 'keep' : 'run'))
    if (r.error) return send(sock, { type: 'error', code: 'render-failed', error: r.error })
    const forRun = r.made.filter((x) => x.lifetime === 'run')
    const cleanup = (reason) => { for (const x of forRun) unrender(x, reason) }

    const env = { ...process.env }
    for (const [name, value] of values) env[name] = value
    const secrets = secretsForScrub()

    let child
    try {
      child = spawnArgv(argv, { cwd: req.cwd || undefined, env, spawnFn })
    } catch (err) {
      cleanup('spawn-failed')
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
      cleanup('run-ended')
      audit('run', { argv, use, error: String(err?.message || err) })
      send(sock, { type: 'error', code: 'spawn-failed', error: String(err?.message || err) })
    })
    child.on('close', (code, signal) => {
      if (done) return
      done = true
      cleanup('run-ended')
      audit('run', {
        argv, use, code, signal, ms: Date.now() - startedAt, rendered: r.made.map((x) => x.path),
      })
      send(sock, { type: 'exit', code, signal })
    })
    // The CLI going away mid-run must not leave the child running with the
    // values in its environment.
    sock.on('close', () => {
      if (!done && child.pid) killTree(child.pid)
    })
  }

  function handleRender(req, sock) {
    if (!filled) return send(sock, { type: 'error', code: 'not-filled', error: 'nothing has been filled in yet — run `mp secret wait` first' })
    const renders = Array.isArray(req.renders) ? req.renders : []
    if (!renders.length) return send(sock, { type: 'error', code: 'bad-render', error: 'name at least one TEMPLATE=OUTPUT' })
    const m = matchApproved(renders)
    if (m.error) return send(sock, { type: 'error', ...m.error })
    const r = renderAll(m.matched, (ap) => (ap.keep ? 'keep' : 'slot'))
    if (r.error) return send(sock, { type: 'error', code: 'render-failed', error: r.error })
    return send(sock, {
      type: 'ok',
      rendered: r.made.map(({ path, lifetime, sha256_8: sha }) => ({ path, lifetime, sha256_8: sha })),
    })
  }

  // The contents of a rendered file with the values redacted, so the AI can
  // check the shape of a config without ever holding the key. The file is
  // read here, where the values already are; nothing crosses to the CLI but
  // the redacted text.
  function handlePeek(req, sock) {
    const p = String(req.path ?? '')
    const known = rendered.some((r) => samePath(r.path, p))
      || state.readKeptFiles().some((k) => samePath(k.path, p) && projectRoot && samePath(k.project, projectRoot))
    if (!known) {
      return send(sock, {
        type: 'error', code: 'not-rendered', error: `${p} is not a file this slot rendered. peek only shows what mp itself wrote.`,
      })
    }
    let text
    try {
      text = readFileSync(p, 'utf8')
    } catch (err) {
      return send(sock, { type: 'error', code: 'unreadable', error: `cannot read ${p}: ${err.code || err.message}` })
    }
    audit('peek', { path: p })
    return send(sock, { type: 'ok', content: scrubText(text, secretsForScrub()) })
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
      files: approvedFiles,
      pendingUses: form ? form.offeredUses : [],
      renderedFiles: rendered.map((r) => ({ ...r })),
      expiresAt,
    }
  }

  async function handleReopen(req, sock) {
    if (!filled) return send(sock, { type: 'error', code: 'not-filled', error: 'nothing has been filled in yet' })
    if (form) return send(sock, { type: 'error', code: 'form-open', error: 'a form link is already open for this slot; wait for it or let it expire' })
    const offered = Array.isArray(req.uses) ? req.uses.filter((u) => typeof u === 'string' && u.trim()) : []
    const offeredFiles = Array.isArray(req.files)
      ? req.files.filter((f) => f && typeof f.template === 'string' && typeof f.out === 'string').map(plainFile)
      : []
    if (!offered.length && !offeredFiles.length) return send(sock, { type: 'error', code: 'bad-uses', error: 'no uses to approve' })
    const fresh = offered.filter((u) => !approvedUses.includes(u))
    const freshFiles = offeredFiles.filter((f) => !approvedFiles.some((a) => sameFile(a, f)))
    if (!fresh.length && !freshFiles.length) return send(sock, { type: 'ok', alreadyApproved: true })

    send(sock, { type: 'ok' })
    try {
      await openForm({ mode: 'approve', offeredUses: fresh, offeredFiles: freshFiles.map((f) => fileForForm(f, true)) })
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
      case 'render': return handleRender(req, sock)
      case 'peek': return handlePeek(req, sock)
      case 'reopen': return handleReopen(req, sock)
      case 'forget':
        send(sock, { type: 'ok' })
        sock.end()
        audit('forget')
        setImmediate(() => exitOnShutdown(0))
        return undefined
      default:
        // Deliberately the whole surface: there is no `get`, and a request
        // for one is answered the same way as any other typo. `peek` returns
        // a rendered file only after redacting every value in it.
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

  const wipe = (reason) => {
    closeForm(reason)
    unrenderAll(reason)
    values.clear()
    approvedUses = []
    approvedFiles = []
    vault?.dispose?.()
    try {
      ipc.close()
    } catch {
      // already closed
    }
  }

  const shutdown = () => {
    if (disposed) return
    wipe('shutdown')
    if (process.platform !== 'win32') rmSync(ipcPath, { force: true })
    clearOwnedSecret(id, ownerPid)
  }

  const exitOnShutdown = (code = 0) => {
    // A record that ended in an error is left for `mp secret wait` and
    // `status` to read and report; a clean end leaves nothing.
    if (code === 0) shutdown()
    else wipe('shutdown')
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
    wipe('dispose')
    if (process.platform !== 'win32') rmSync(ipcPath, { force: true })
    state.clearSecret(id)
  }

  const handleResult = {
    id, ipcPath, shutdown, dispose, formPort: () => form?.formPort ?? null,
  }

  // ---- start ----

  await prepareVault()

  const declared = unionFiles([], renders.map(plainFile))
  const newUses = uses.filter((u) => !remembered.uses.includes(u))
  const newFiles = declared.filter((d) => !remembered.files.some((r) => sameFile(r, d)))
  const allSaved = () => !refill && names.length > 0 && names.every((n) => saved[n]?.status === 'saved')

  if (allSaved() && strictestLevel(names.map((n) => saved[n].level)) === 'auto') {
    const { values: v, failed } = vault.openFields(projectRoot, names)
    if (!failed.length) {
      persisted = true
      vault.touch(projectRoot, names)
      vaultAudit('used', {
        pid, root: projectRoot, fields: names, slot: id, how: 'auto',
      })
      audit('auto-filled', { fields: names, uses: remembered.uses })
      const filledPatch = holdValues(v, {
        uses: remembered.uses, files: remembered.files, source: 'saved', level: 'auto',
      })
      if (!newUses.length && !newFiles.length) {
        patch({ ...filledPatch, stage: 'filled', stageAt: Date.now() })
        return handleResult
      }
      // The values are in; only the new approvals need the phone. The stage
      // stays 'starting' until the link is up, so `mp secret ask` waits for
      // the link instead of reporting "filled" and never showing it.
      patch({ ...filledPatch, stage: 'starting', stageAt: Date.now() })
      try {
        await openForm({
          mode: 'approve', offeredUses: newUses, offeredFiles: newFiles.map((f) => fileForForm(f, true)),
        })
      } catch (err) {
        closeForm('tunnel-failed')
        patch({ reopenError: String(err?.message || err), stage: 'filled', stageAt: Date.now() })
        audit('reopen-failed', { error: String(err?.message || err) })
      }
      return handleResult
    }
    // Tampered with: ask for those again rather than trust them.
    for (const n of failed) delete saved[n]
  }

  const mode = allSaved() ? 'confirm' : 'fill'
  const offeredUses = [...new Set([...remembered.uses, ...uses])]
  const offeredFiles = [
    ...remembered.files.map((f) => fileForForm(f, false)),
    ...newFiles.map((f) => fileForForm(f, mode === 'confirm')),
  ]
  try {
    await openForm({
      mode, offeredUses, offeredFiles, newUses: mode === 'confirm' ? newUses : null,
    })
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

  return handleResult
}
