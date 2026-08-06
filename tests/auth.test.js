import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mintToken, hashToken, tokenMatches,
  parseArtifactPath, isBlockedPath, readCookie,
} from '../src/auth.js'

test('mintToken produces 43-char base64url and is not repeatable', () => {
  const a = mintToken()
  const b = mintToken()
  assert.equal(a.length, 43)
  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
})

test('tokenMatches accepts the right token and rejects others', () => {
  const t = mintToken()
  const h = hashToken(t)
  assert.equal(tokenMatches(t, h), true)
  assert.equal(tokenMatches(mintToken(), h), false)
})

test('tokenMatches rejects malformed input without throwing', () => {
  const h = hashToken(mintToken())
  assert.equal(tokenMatches('', h), false)
  assert.equal(tokenMatches('short', h), false)
  assert.equal(tokenMatches(null, h), false)
  assert.equal(tokenMatches('x'.repeat(43), 'not-a-hash'), false)
})

test('parseArtifactPath extracts token and filename', () => {
  const t = mintToken()
  assert.deepEqual(parseArtifactPath(`/_a/${t}/shot-1.png`), { token: t, file: 'shot-1.png' })
})

test('parseArtifactPath rejects traversal and nesting', () => {
  const t = mintToken()
  assert.equal(parseArtifactPath(`/_a/${t}/../state.json`), null)
  assert.equal(parseArtifactPath(`/_a/${t}/sub/shot.png`), null)
  assert.equal(parseArtifactPath(`/_a/${t}/`), null)
  assert.equal(parseArtifactPath('/_a/tooshort/shot.png'), null)
  assert.equal(parseArtifactPath('/shot-1.png'), null)
})

test('always-blocked paths are blocked in both modes', () => {
  for (const dev of [false, true]) {
    assert.equal(isBlockedPath('/@fs/C:/Users/me/.ssh/id_rsa', { dev }), true, `@fs dev=${dev}`)
    assert.equal(isBlockedPath('/.env', { dev }), true, `.env dev=${dev}`)
    assert.equal(isBlockedPath('/.env.local', { dev }), true, `.env.local dev=${dev}`)
    assert.equal(isBlockedPath('/app/.env', { dev }), true, `nested .env dev=${dev}`)
    assert.equal(isBlockedPath('/.git/config', { dev }), true, `.git dev=${dev}`)
  }
})

test('encoded sensitive paths are blocked in both modes', () => {
  const paths = [
    '/%40fs/C:/Users/me/.ssh/id_rsa',
    '/%2eenv',
    '/app/%2eenv.local',
    '/%2egit/config',
    '/%252eenv',
    '/%2540fs/C:/Users/me/.ssh/id_rsa',
  ]

  for (const dev of [false, true]) {
    for (const p of paths) {
      assert.equal(isBlockedPath(p, { dev }), true, `${p} dev=${dev}`)
    }
  }
})

test('malformed encoded paths fail closed', () => {
  assert.equal(isBlockedPath('/%E0%A4%A', { dev: false }), true)
  assert.equal(isBlockedPath('/%E0%A4%A', { dev: true }), true)
})

test('dev-only paths are blocked by default and allowed with dev', () => {
  const paths = ['/@vite/client', '/@id/foo', '/node_modules/vite/x.js', '/assets/app.js.map']
  for (const p of paths) {
    assert.equal(isBlockedPath(p, { dev: false }), true, `${p} should be blocked by default`)
    assert.equal(isBlockedPath(p, { dev: true }), false, `${p} should be allowed in dev`)
  }
})

test('ordinary paths are never blocked', () => {
  for (const dev of [false, true]) {
    assert.equal(isBlockedPath('/', { dev }), false)
    assert.equal(isBlockedPath('/index.html', { dev }), false)
    assert.equal(isBlockedPath('/assets/app-a1b2.js', { dev }), false)
    assert.equal(isBlockedPath('/api/users', { dev }), false)
  }
})

test('readCookie finds a named cookie among several', () => {
  assert.equal(readCookie('a=1; mp_session=abc123; b=2', 'mp_session'), 'abc123')
  assert.equal(readCookie('mp_session=solo', 'mp_session'), 'solo')
  assert.equal(readCookie('other=1', 'mp_session'), null)
  assert.equal(readCookie(undefined, 'mp_session'), null)
})

test('readCookie does not match a name that is a suffix of another', () => {
  assert.equal(readCookie('xmp_session=wrong', 'mp_session'), null)
})
