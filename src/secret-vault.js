import { spawnSync } from 'node:child_process'
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes,
  scrypt as scryptCb, timingSafeEqual,
} from 'node:crypto'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import * as state from './state.js'
import { accountFor } from './keystore.js'

// Saved values. The 2026-09-21 secret-vault design is the reference; the
// short version:
//
// - One random vault key K per user, wrapped by the system keystore
//   (keystore.js). Each field is AES-256-GCM under K — or, at the passphrase
//   level, under K_p = HKDF(K ‖ scrypt(passphrase)), so a copy of the vault
//   needs this machine's keystore *and* the passphrase.
// - The level and the expiry are part of each field's associated data, so an
//   edit to either makes the field fail to decrypt instead of quietly
//   loosening it. The remembered uses and render targets carry an HMAC.
// - Only a daemon ever holds K. The CLI reads the plaintext metadata (names,
//   fingerprints, dates) straight from the file and never decrypts.
//
// None of this stops an AI that runs as the same user and sets out to call
// the keystore itself; §2 of the design says so, and only the passphrase
// level is an exception.

const scrypt = promisify(scryptCb)

export const LEVELS = ['auto', 'confirm', 'passphrase']
const RANK = { auto: 0, confirm: 1, passphrase: 2 }
export const DEFAULT_LEVEL = 'auto'
export const EXPIRY_DAYS = [7, 30, 90, 0]
export const DEFAULT_EXPIRY_DAYS = 90
export const PASSPHRASE_MIN_LENGTH = 6
export const MAX_PASSPHRASE_FAILURES = 5
// OWASP's scrypt setting: 128 MiB, a few tenths of a second. Node refuses
// anything above 32 MiB unless maxmem says otherwise.
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 }
const SCRYPT_MAXMEM = 256 * 1024 * 1024
const DAY_MS = 86_400_000

export function strictestLevel(levels) {
  return levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'auto')
}

export function expiresAtFor(days, now = Date.now()) {
  return days ? now + days * DAY_MS : null
}

// Shown on the phone as-is. Six characters, digits allowed — like a payment
// PIN, by the user's decision (2026-09-21, design §13). The difference from a
// payment PIN is that nobody counts the attempts: an AI can read the vault and
// try guesses offline. A 6-digit PIN is 10⁶ guesses at ~0.3 s each, about 3.5
// days on one core and 11 hours on eight, so at that length the passphrase
// delays a deliberate AI rather than stopping it; longer ones delay it more.
export function passphraseProblem(p) {
  const s = String(p ?? '')
  if ([...s].length < PASSPHRASE_MIN_LENGTH) return `主密码至少 ${PASSPHRASE_MIN_LENGTH} 位`
  return null
}

// Enough for the user to tell "I pasted the wrong one" from the phone, not
// enough to help anyone guess the value.
export function fingerprint(value) {
  const v = String(value ?? '')
  return { length: v.length, sha256_8: createHash('sha256').update(v).digest('hex').slice(0, 8) }
}

// ---- which project ----

export function normalizeRoot(p, { platform = process.platform } = {}) {
  let r = resolve(String(p))
  try {
    r = realpathSync.native(r)
  } catch {
    // a path that does not exist yet is still a name for a project
  }
  return platform === 'win32' ? r.toLowerCase() : r
}

// The git work tree the command runs in, or the directory itself outside one.
export function projectRoot(cwd = process.cwd(), { spawnSyncFn = spawnSync } = {}) {
  let top = null
  try {
    const r = spawnSyncFn('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    })
    if (r.status === 0 && r.stdout?.trim()) top = r.stdout.trim()
  } catch {
    // no git: the directory is the project
  }
  return normalizeRoot(top || cwd)
}

export function projectId(root) {
  return createHash('sha256').update(String(root)).digest('hex').slice(0, 16)
}

// ---- crypto ----

export function fieldAad(pid, { name, kind, level, expiresAt }) {
  return Buffer.from(['mp-vault-v1', pid, name, kind, level, expiresAt ?? 'never'].join('|'), 'utf8')
}

export function sealValue(key, aad, value) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aad)
  const ct = Buffer.concat([c.update(String(value), 'utf8'), c.final(), c.getAuthTag()])
  return { iv: iv.toString('base64'), ct: ct.toString('base64') }
}

export function openValue(key, aad, { iv, ct } = {}) {
  const ivBuf = Buffer.from(String(iv ?? ''), 'base64')
  const data = Buffer.from(String(ct ?? ''), 'base64')
  if (ivBuf.length !== 12 || data.length < 16) throw new Error('malformed ciphertext')
  const d = createDecipheriv('aes-256-gcm', key, ivBuf)
  d.setAAD(aad)
  d.setAuthTag(data.subarray(data.length - 16))
  try {
    return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8')
  } catch {
    throw new Error('authentication failed')
  }
}

const sortedNames = (names) => [...new Set(names)].sort()

function canonicalLists({ uses = [], files = [] }) {
  const u = uses
    .map((e) => ({ use: e.use, fields: sortedNames(e.fields || []) }))
    .sort((a, b) => `${a.use}\n${a.fields}`.localeCompare(`${b.use}\n${b.fields}`))
  const f = files
    .map((e) => ({
      template: e.template, out: e.out, keep: Boolean(e.keep), fields: sortedNames(e.fields || []),
    }))
    .sort((a, b) => `${a.out}\n${a.template}\n${a.fields}`.localeCompare(`${b.out}\n${b.template}\n${b.fields}`))
  return JSON.stringify({ uses: u, files: f })
}

export function listsMac(K, pid, lists) {
  const mk = Buffer.from(hkdfSync('sha256', K, Buffer.from(pid), 'mp-vault-mac-v1', 32))
  return createHmac('sha256', mk).update(canonicalLists(lists)).digest('base64')
}

function macOk(K, pid, lists, mac) {
  if (typeof mac !== 'string') return false
  const a = Buffer.from(listsMac(K, pid, lists), 'base64')
  const b = Buffer.from(mac, 'base64')
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function passphraseKey(K, passphrase, { salt, N, r, p }) {
  const saltBuf = Buffer.from(salt, 'base64')
  const stretched = await scrypt(Buffer.from(String(passphrase).normalize('NFC'), 'utf8'), saltBuf, 32, {
    N, r, p, maxmem: SCRYPT_MAXMEM,
  })
  const Kp = Buffer.from(hkdfSync('sha256', Buffer.concat([K, stretched]), saltBuf, 'mp-vault-passphrase-v1', 32))
  stretched.fill(0)
  return Kp
}

const CHECK = 'mp-vault-check-v1'
const checkAad = Buffer.from(CHECK)

export function makeCheck(Kp) {
  return sealValue(Kp, checkAad, CHECK)
}

export function checkOk(Kp, check) {
  try {
    return openValue(Kp, checkAad, check) === CHECK
  } catch {
    return false
  }
}

export class PassphraseError extends Error {}

// ---- remembered approvals ----
//
// A use is remembered together with the fields it was approved for: running
// `npm run deploy` with the OSS keys says nothing about running it with the
// database password too. An entry applies to an ask whose fields are all
// among the entry's.

export function appliesTo(entry, names) {
  return names.every((n) => (entry.fields || []).includes(n))
}

export function fileKey(f) {
  return `${f.template}\n${f.out}\n${f.keep ? 'keep' : ''}`
}

// ---- the vault ----

export function vaultAudit(event, extra = {}) {
  try {
    const f = state.vaultAuditPath()
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`)
  } catch {
    // same rule as the slot audit log: losing a line must not fail the act
  }
}

export function fieldStatus(meta, now = Date.now()) {
  if (!meta) return 'missing'
  if (meta.expiresAt && now > meta.expiresAt) return 'expired'
  return 'saved'
}

// Everything the CLI may see about a project: no iv, no ct.
export function publicView(root, now = Date.now()) {
  const pid = projectId(root)
  const { status, value } = state.readVaultProject(pid)
  if (status === 'corrupt') return { pid, root, corrupt: true, fields: {}, uses: [], files: [] }
  return viewOf(value, pid, root, now)
}

export function viewOf(value, pid, root, now = Date.now()) {
  const fields = {}
  for (const [name, meta] of Object.entries(value?.fields || {})) {
    const { iv: _iv, ct: _ct, ...rest } = meta
    fields[name] = { ...rest, status: fieldStatus(meta, now) }
  }
  return {
    pid, root: value?.root ?? root, fields, uses: value?.uses || [], files: value?.files || [], exists: Boolean(value),
  }
}

export function createVault({ keystore, now = () => Date.now() } = {}) {
  let K = null

  function keyFile() {
    const { status, value } = state.readVaultKeyFile()
    if (status === 'corrupt') throw new Error(`the vault key file is corrupt (${state.vaultKeyPath()})`)
    return value
  }

  function raw(root) {
    const pid = projectId(root)
    const { status, value } = state.readVaultProject(pid)
    if (status === 'corrupt') throw new Error(`the saved values for this project are corrupt (${state.vaultProjectPath(pid)})`)
    return { pid, value }
  }

  const vault = {
    async available() {
      if (!keystore) return false
      try {
        return await keystore.available()
      } catch {
        return false
      }
    },

    hasPassphrase() {
      return Boolean(keyFile()?.passphrase)
    },

    // K, from the keystore. With `create`, a vault that has no key yet gets
    // one; without it, no key means null.
    async loadKey({ create = false } = {}) {
      if (K) return K
      const kf = keyFile()
      if (kf?.record) {
        const k = await keystore.open(kf.record)
        if (k.length !== 32) throw new Error('the vault key has the wrong length')
        K = k
        return K
      }
      if (!create) return null
      if (!(await vault.available())) throw new Error('no usable system keystore on this computer')

      const fresh = randomBytes(32)
      // A per-key account name: two first saves racing each other must not
      // overwrite one keychain item with the other's key.
      const record = await keystore.seal(fresh, { account: `${accountFor(state.vaultDir())}-${randomBytes(4).toString('hex')}` })
      const written = state.writeVaultKeyFile((cur) => (cur.record ? {} : { version: 1, record, createdAt: now() }))
      if (JSON.stringify(written.record) === JSON.stringify(record)) {
        K = fresh
        vaultAudit('key-created', { wrap: record.wrap })
      } else {
        await keystore.remove(record).catch(() => {})
        K = await keystore.open(written.record)
      }
      return K
    },

    // K_p. `create` sets the passphrase when the vault has none yet.
    async unlock(passphrase, { create = false } = {}) {
      const k = await vault.loadKey({ create })
      if (!k) throw new PassphraseError('还没有设置主密码')
      const kf = keyFile()
      if (!kf?.passphrase) {
        if (!create) throw new PassphraseError('还没有设置主密码')
        const problem = passphraseProblem(passphrase)
        if (problem) throw new PassphraseError(problem)
        const params = { salt: randomBytes(16).toString('base64'), ...SCRYPT_PARAMS }
        const Kp = await passphraseKey(k, passphrase, params)
        const written = state.writeVaultKeyFile((cur) => (cur.passphrase ? {} : { passphrase: { ...params, check: makeCheck(Kp) } }))
        if (!checkOk(Kp, written.passphrase.check)) {
          Kp.fill(0)
          throw new PassphraseError('主密码不对')
        }
        vaultAudit('passphrase-set')
        return Kp
      }
      const Kp = await passphraseKey(k, passphrase, kf.passphrase)
      if (!checkOk(Kp, kf.passphrase.check)) {
        Kp.fill(0)
        throw new PassphraseError('主密码不对')
      }
      return Kp
    },

    view(root) {
      return publicView(root, now())
    },

    // The remembered approvals, or nothing if their HMAC does not hold.
    lists(root, k = K) {
      const { pid, value } = raw(root)
      const uses = value?.uses || []
      const files = value?.files || []
      if (!uses.length && !files.length) return { uses: [], files: [], ok: true }
      if (!k || !macOk(k, pid, { uses, files }, value.mac)) {
        vaultAudit('tamper', { pid, what: 'remembered uses and render targets' })
        return { uses: [], files: [], ok: false }
      }
      return { uses, files, ok: true }
    },

    // Decrypts what it can. A field whose ciphertext or associated data does
    // not check out is reported, never returned.
    openFields(root, names, { Kp = null } = {}) {
      const { pid, value } = raw(root)
      const values = {}
      const failed = []
      for (const name of names) {
        const meta = value?.fields?.[name]
        const key = meta?.level === 'passphrase' ? Kp : K
        if (!meta || !key) {
          failed.push(name)
          continue
        }
        try {
          values[name] = openValue(key, fieldAad(pid, { name, ...meta }), meta)
        } catch {
          failed.push(name)
          vaultAudit('tamper', { pid, field: name })
        }
      }
      return { values, failed }
    },

    save(root, entries, { level, days, Kp = null }) {
      if (!LEVELS.includes(level)) throw new Error(`bad level ${JSON.stringify(level)}`)
      const key = level === 'passphrase' ? Kp : K
      if (!key) throw new Error(level === 'passphrase' ? 'the passphrase key is not unlocked' : 'the vault key is not loaded')
      const pid = projectId(root)
      const t = now()
      const expiresAt = expiresAtFor(days, t)
      state.writeVaultProject(pid, (cur) => {
        const fields = { ...(cur.fields || {}) }
        for (const { name, kind, value } of entries) {
          const meta = { kind, level, savedAt: t, expiresAt, ...fingerprint(value) }
          fields[name] = {
            ...meta,
            ...sealValue(key, fieldAad(pid, { name, ...meta }), value),
            lastUsedAt: t,
            useCount: (cur.fields?.[name]?.useCount ?? 0) + 1,
          }
        }
        return { version: 1, root, fields }
      })
      vaultAudit('saved', {
        pid, root, fields: entries.map((e) => e.name), level, expiresAt,
      })
    },

    setLists(root, { uses, files }) {
      if (!K) throw new Error('the vault key is not loaded')
      const { pid, value } = raw(root)
      if (!value) return
      const lists = { uses, files }
      state.writeVaultProject(pid, { uses, files, mac: listsMac(K, pid, lists) })
    },

    touch(root, names) {
      const { pid, value } = raw(root)
      if (!value) return
      const t = now()
      state.writeVaultProject(pid, (cur) => {
        const fields = { ...(cur.fields || {}) }
        for (const n of names) {
          if (fields[n]) fields[n] = { ...fields[n], lastUsedAt: t, useCount: (fields[n].useCount ?? 0) + 1 }
        }
        return { fields }
      })
    },

    dispose() {
      K?.fill(0)
      K = null
    },
  }
  return vault
}

// Deleting needs no key, so the CLI does it directly. What is left of a
// project that has no fields and keeps no rendered file is removed entirely.
export function removeSaved(root, names = null) {
  const pid = projectId(root)
  const { status, value } = state.readVaultProject(pid)
  if (status === 'corrupt') {
    state.clearVaultProject(pid)
    vaultAudit('deleted', { pid, root, corrupt: true })
    return { removed: ['(corrupt file)'] }
  }
  if (!value) return { removed: [] }

  const all = Object.keys(value.fields || {})
  const removed = names ? names.filter((n) => all.includes(n)) : all
  const next = state.writeVaultProject(pid, (cur) => {
    const fields = { ...(cur.fields || {}) }
    for (const n of removed) delete fields[n]
    return { fields }
  })
  if (!Object.keys(next.fields || {}).length && !(next.files || []).some((f) => f.keep)) {
    state.clearVaultProject(pid)
  }
  if (removed.length) vaultAudit('deleted', { pid, root, fields: removed })
  return { removed }
}
