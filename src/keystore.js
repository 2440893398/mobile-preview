import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Where the vault key K lives when it is not in a daemon's memory: whatever
// the operating system offers for "this user's secrets" — DPAPI on Windows,
// the login keychain on macOS, the Secret Service on Linux.
//
// None of these keeps K from an AI running as the same user; the vault design
// (2026-09-21 §2, §4.2) says so up front. What they do keep K from is a copy
// of the vault that left this machine, and a scanner that only reads files.
//
// K never goes on a command line. Another process of the same user can read a
// process's arguments, so K travels through stdin and stdout only; the scripts
// that go on the command line contain nothing secret.
//
// There is no plaintext fallback. A keystore that is not there makes saving
// unavailable — the gh CLI falls back to a plain file and has been reported
// for it (cli/cli#10108).

const SERVICE = 'mobile-preview'
const DPAPI_ENTROPY = 'mobile-preview-vault-v1'

export function runWithInput(file, args, input = '', { timeoutMs = 20_000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err) })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      finish({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d })
    child.on('error', (err) => finish({ code: -1, stdout, stderr: String(err?.message || err) }))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

// ---- Windows: DPAPI through Windows PowerShell ----

function powershellPath(env = process.env) {
  // The absolute path, not whatever `powershell.exe` PATH turns up first.
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  const p = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(p) ? p : 'powershell.exe'
}

function dpapiScript(op) {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    `$out = [Security.Cryptography.ProtectedData]::${op}($data, $entropy, 'CurrentUser')`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ')
}

const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64')

function dpapiKeystore({ run = runWithInput, env = process.env } = {}) {
  const exe = powershellPath(env)
  const call = async (op, b64) => {
    const r = await run(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(dpapiScript(op))], b64)
    const out = r.stdout.trim()
    if (r.code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(out)) {
      throw new Error(`DPAPI ${op} failed: ${(r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`}`)
    }
    return out
  }
  return {
    name: 'dpapi',
    async seal(key) {
      return { wrap: 'dpapi', blob: await call('Protect', key.toString('base64')) }
    },
    async open(record) {
      if (record?.wrap !== 'dpapi' || typeof record.blob !== 'string') throw new Error('not a DPAPI record')
      return Buffer.from(await call('Unprotect', record.blob), 'base64')
    },
    async remove() {},
  }
}

// ---- macOS: login keychain through `security` ----

function keychainKeystore({ run = runWithInput } = {}) {
  return {
    name: 'keychain',
    async seal(key, { account }) {
      // `security -i` reads its commands from stdin, so the value is never an
      // argument of any process. base64 has no quotes or spaces to escape.
      const line = `add-generic-password -U -s ${SERVICE} -a ${account} -w ${key.toString('base64')}\n`
      const r = await run('security', ['-i'], line)
      if (r.code !== 0) throw new Error(`keychain store failed: ${r.stderr.trim() || `exit ${r.code}`}`)
      return { wrap: 'keychain', service: SERVICE, account }
    },
    async open(record) {
      if (record?.wrap !== 'keychain') throw new Error('not a keychain record')
      const r = await run('security', ['find-generic-password', '-s', record.service, '-a', record.account, '-w'])
      if (r.code !== 0) throw new Error(`keychain lookup failed: ${r.stderr.trim() || `exit ${r.code}`}`)
      return Buffer.from(r.stdout.trim(), 'base64')
    },
    async remove(record) {
      await run('security', ['delete-generic-password', '-s', record.service, '-a', record.account])
    },
  }
}

// ---- Linux: Secret Service through `secret-tool` ----

function libsecretKeystore({ run = runWithInput } = {}) {
  return {
    name: 'libsecret',
    async seal(key, { account }) {
      const r = await run('secret-tool', ['store', '--label', 'mobile-preview vault key', 'service', SERVICE, 'account', account], key.toString('base64'))
      if (r.code !== 0) throw new Error(`secret-tool store failed: ${r.stderr.trim() || `exit ${r.code}`}`)
      return { wrap: 'libsecret', service: SERVICE, account }
    },
    async open(record) {
      if (record?.wrap !== 'libsecret') throw new Error('not a libsecret record')
      const r = await run('secret-tool', ['lookup', 'service', record.service, 'account', record.account])
      if (r.code !== 0 || !r.stdout.trim()) throw new Error(`secret-tool lookup failed: ${r.stderr.trim() || `exit ${r.code}`}`)
      return Buffer.from(r.stdout.trim(), 'base64')
    },
    async remove(record) {
      await run('secret-tool', ['clear', 'service', record.service, 'account', record.account])
    },
  }
}

// One account name per vault directory, so a test vault (MP_STATE_DIR) never
// touches the real one's keychain entry.
export function accountFor(vaultDir) {
  return `vault-${createHash('sha256').update(String(vaultDir)).digest('hex').slice(0, 16)}`
}

// Wraps a platform keystore with the round-trip probe: a keystore is only
// "available" once a random value has gone in and come back out unchanged.
// Constrained Language Mode, a missing Secret Service, a locked keychain —
// all of them end here as `false`, never as a half-saved vault.
export function withProbe(ks) {
  let probed = null
  return {
    ...ks,
    available() {
      probed ??= (async () => {
        const probe = randomBytes(16)
        let record = null
        try {
          record = await ks.seal(probe, { account: `probe-${randomBytes(4).toString('hex')}` })
          const back = await ks.open(record)
          return back.equals(probe)
        } catch {
          return false
        } finally {
          if (record) await ks.remove(record).catch(() => {})
        }
      })()
      return probed
    },
  }
}

export function platformKeystore({ platform = process.platform, run = runWithInput, env = process.env } = {}) {
  if (platform === 'win32') return withProbe(dpapiKeystore({ run, env }))
  if (platform === 'darwin') return withProbe(keychainKeystore({ run }))
  return withProbe(libsecretKeystore({ run }))
}

// For tests only, and only ever passed in by a test: nothing selects it from
// the environment. An env switch here would let whoever runs `mp` quietly
// swap the user's keystore for one that keeps K in the clear.
export function memoryKeystore({ available = true } = {}) {
  const store = new Map()
  let n = 0
  return {
    name: 'memory',
    available: async () => available,
    async seal(key) {
      if (!available) throw new Error('keystore unavailable')
      n += 1
      store.set(`m${n}`, Buffer.from(key))
      return { wrap: 'memory', id: `m${n}` }
    },
    async open(record) {
      const k = store.get(record?.id)
      if (!k) throw new Error('no such memory record')
      return Buffer.from(k)
    },
    async remove(record) {
      store.delete(record?.id)
    },
  }
}
