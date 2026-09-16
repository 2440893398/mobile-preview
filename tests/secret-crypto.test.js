import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_ENCRYPT_JS, decryptField, decryptSubmission, deriveKey, generateServerKeys,
} from '../src/secret-crypto.js'

// 浏览器那一侧的代码原样在 Node 的 WebCrypto 上跑：这不是模拟，是同一套 API。
const mpEncrypt = new Function(`${BROWSER_ENCRYPT_JS}; return mpEncrypt`)()

test('浏览器加密、daemon 解密：每个字段往返一致', async () => {
  const { privateKey, publicJwk } = generateServerKeys()
  const fields = { OSS_KEY: 'LTAI5t9f3c1e0b2a', OSS_SECRET: 'p@ss 密码 "quoted" \\ back', EMPTY: '' }

  const payload = await mpEncrypt(publicJwk, fields)
  const values = decryptSubmission(privateKey, payload, Object.keys(fields))

  assert.deepEqual(values, fields)
})

test('密文里没有明文，公钥里没有私钥', async () => {
  const { publicJwk } = generateServerKeys()
  const payload = await mpEncrypt(publicJwk, { K: 'hunter2hunter2' })

  assert.ok(!JSON.stringify(payload).includes('hunter2'))
  assert.equal(publicJwk.d, undefined)
  assert.deepEqual(Object.keys(publicJwk).sort(), ['crv', 'kty', 'x', 'y'])
})

test('字段名是 AAD：把一个字段的密文挪到另一个字段名下会被拒绝', async () => {
  const { privateKey, publicJwk } = generateServerKeys()
  const payload = await mpEncrypt(publicJwk, { A: 'value-for-a', B: 'value-for-b' })
  const swapped = { ...payload, fields: { A: payload.fields.B, B: payload.fields.A } }

  assert.throws(() => decryptSubmission(privateKey, swapped, ['A', 'B']), /authentication failed/)
})

test('篡改密文一个字节即失败', async () => {
  const { privateKey, publicJwk } = generateServerKeys()
  const payload = await mpEncrypt(publicJwk, { A: 'value-for-a' })
  const ct = Buffer.from(payload.fields.A.ct, 'base64')
  ct[0] ^= 1
  payload.fields.A.ct = ct.toString('base64')

  assert.throws(() => decryptSubmission(privateKey, payload, ['A']), /authentication failed/)
})

test('用另一把服务端私钥解不开', async () => {
  const a = generateServerKeys()
  const b = generateServerKeys()
  const payload = await mpEncrypt(a.publicJwk, { A: 'value-for-a' })

  assert.throws(() => decryptSubmission(b.privateKey, payload, ['A']), /authentication failed/)
})

test('缺字段、多字段、坏公钥、短盐都拒绝', async () => {
  const { privateKey, publicJwk } = generateServerKeys()
  const payload = await mpEncrypt(publicJwk, { A: 'value-for-a' })

  assert.throws(() => decryptSubmission(privateKey, payload, ['A', 'B']), /field B is missing/)
  assert.throws(() => decryptSubmission(privateKey, payload, []), /unexpected field A/)
  assert.throws(() => deriveKey(privateKey, { kty: 'RSA' }, payload.salt), /not a P-256/)
  assert.throws(() => deriveKey(privateKey, payload.clientPub, 'AAAA'), /salt is too short/)
  assert.throws(() => decryptSubmission(privateKey, { ...payload, fields: null }, ['A']), /no fields/)
})

test('畸形密文报错而不是崩掉', () => {
  const key = Buffer.alloc(32, 1)
  assert.throws(() => decryptField(key, 'A', { iv: 'AA==', ct: 'AA==' }), /malformed/)
  assert.throws(() => decryptField(key, 'A', {}), /malformed/)
})
