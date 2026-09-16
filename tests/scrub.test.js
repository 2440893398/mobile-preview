import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScrubber, scrubText, variantsOf } from '../src/scrub.js'

const SECRET = 'sk-live-9f3c1e0b2a7d'
const S = [{ name: 'API_KEY', value: SECRET }]

test('本体被替换成 [REDACTED:NAME]', () => {
  assert.equal(scrubText(`token=${SECRET} ok`, S), 'token=[REDACTED:API_KEY] ok')
})

test('四种常见变形也被替换：base64、base64url、URL 编码、JSON 转义', () => {
  const v = 'p@ss/w+rd="x"'
  const secrets = [{ name: 'PW', value: v }]
  const b64 = Buffer.from(v).toString('base64')
  const b64url = Buffer.from(v).toString('base64url')
  const url = encodeURIComponent(v)
  const json = JSON.stringify(v).slice(1, -1)

  for (const form of [v, b64, b64url, url, json]) {
    assert.equal(scrubText(`<${form}>`, secrets), '<[REDACTED:PW]>', `未替换形态 ${form}`)
  }
})

test('跨 chunk 边界的值也会被替换', () => {
  const s = createScrubber(S)
  const text = `prefix ${SECRET} suffix`
  let out = ''
  for (const ch of text) out += s.push(ch)
  out += s.flush()
  assert.equal(out, 'prefix [REDACTED:API_KEY] suffix')
})

// 真机实测出来的洞（2026-09-11）：一个 4 字符的值本体被正确遮蔽，紧挨着的
// `base64=Y2VzdA==` 却原样打了出来，值当场可还原。门槛按输入长度判断是错的——
// 短输入的编码形态照样是独特长串，该按编码后的长度判断。
test('短值的编码形态同样要遮蔽：门槛看编码后的长度，不看输入长度', () => {
  const short = [{ name: 'PIN', value: 'cest' }]
  const b64 = Buffer.from('cest').toString('base64')

  assert.ok(variantsOf('cest').includes(b64), 'base64 必须进模式表')
  assert.equal(
    scrubText(`value=cest base64=${b64} b64url=Y2VzdA`, short),
    'value=[REDACTED:PIN] base64=[REDACTED:PIN] b64url=[REDACTED:PIN]',
  )
})

test('编码与值本身相同的形态不重复登记（纯字母数字的 URL 编码就是它自己）', () => {
  assert.deepEqual(variantsOf('abcd'), ['abcd', 'YWJjZA==', 'YWJjZA'])
})

test('多行值里过短的行不单独成模式，否则输出里每个同名短串都会被误伤', () => {
  const secrets = [{ name: 'M', value: 'x\nlongenoughline' }]
  const out = scrubText('x marks the spot; longenoughline', secrets)
  assert.equal(out, 'x marks the spot; [REDACTED:M]')
})

test('多行值的每一行（≥8 字符）单独成为模式，PEM 被逐行打印也能挡住', () => {
  const pem = '-----BEGIN KEY-----\nAAAAB3NzaC1yc2EAAAADAQAB\nshort\n-----END KEY-----'
  const secrets = [{ name: 'PEM', value: pem }]
  const out = scrubText('line: AAAAB3NzaC1yc2EAAAADAQAB\nline: short', secrets)
  assert.equal(out, 'line: [REDACTED:PEM]\nline: short')
})

test('没有秘密时原样透传，flush 后不残留', () => {
  const s = createScrubber([])
  assert.equal(s.push('hello'), 'hello')
  assert.equal(s.flush(), '')
})

test('多个秘密各自命名，长的先匹配', () => {
  const secrets = [
    { name: 'A', value: 'abcdefgh' },
    { name: 'AB', value: 'abcdefghijkl' },
  ]
  assert.equal(scrubText('x abcdefghijkl y abcdefgh z', secrets), 'x [REDACTED:AB] y [REDACTED:A] z')
})

test('正则元字符不会让模式失效', () => {
  const secrets = [{ name: 'RE', value: 'a.b*c(d)[e]' }]
  assert.equal(scrubText('v=a.b*c(d)[e];', secrets), 'v=[REDACTED:RE];')
  assert.equal(scrubText('v=aXbbcddee;', secrets), 'v=aXbbcddee;', '不是字面量就不该匹配')
})
