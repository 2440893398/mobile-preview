import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-render-'))
process.env.MP_STATE_DIR = join(dir, 'state')

const {
  gitProblem, isInside, parseRenderSpec, renderTemplate, samePath, writeRendered, removeRendered,
} = await import('../src/secret-render.js')

const VALUES = { OSS_KEY: 'LTAI5t9f"3c/1e0b', DB_PASS: 'p@ss:w/rd#1' }

test('三种写法：原样、json（带引号、转义）、url', () => {
  const out = renderTemplate([
    'id: {{mp:OSS_KEY}}',
    'secret: {{ mp:OSS_KEY | json }}',
    'url: postgres://app:{{mp:DB_PASS|url}}@localhost/app',
  ].join('\n'), VALUES)
  assert.equal(out, [
    'id: LTAI5t9f"3c/1e0b',
    'secret: "LTAI5t9f\\"3c/1e0b"',
    'url: postgres://app:p%40ss%3Aw%2Frd%231@localhost/app',
  ].join('\n'))
})

test('未知占位符、未知过滤器、写坏的占位符：一律拒绝，不给半成品', () => {
  assert.throws(() => renderTemplate('{{mp:NOPE}}', VALUES), /NOPE/)
  assert.throws(() => renderTemplate('{{mp:OSS_KEY|base64}}', VALUES), /\|base64/)
  assert.throws(() => renderTemplate('{{mp:oss-key}}', VALUES), /malformed/)
  assert.throws(() => renderTemplate('{{mp:OSS_KEY', VALUES), /malformed/)
  assert.equal(renderTemplate('no placeholders {{ other }}', VALUES), 'no placeholders {{ other }}')
})

test('TPL=OUT 用等号分隔，Windows 盘符里的冒号不受影响', () => {
  const r = parseRenderSpec('C:\\app\\config.yml.tpl=C:\\app\\config.yml', 'C:\\')
  if (process.platform === 'win32') {
    assert.ok(samePath(r.template, 'C:\\app\\config.yml.tpl'))
    assert.ok(samePath(r.out, 'C:\\app\\config.yml'))
  }
  const rel = parseRenderSpec('config.yml.tpl=config.yml', dir)
  assert.equal(rel.template, join(dir, 'config.yml.tpl'))
  assert.equal(rel.out, join(dir, 'config.yml'))
  assert.match(parseRenderSpec('config.yml', dir).error, /TEMPLATE=OUTPUT/)
  assert.match(parseRenderSpec('=x', dir).error, /TEMPLATE=OUTPUT/)
})

test('项目内外判断', () => {
  assert.ok(isInside(dir, join(dir, 'a', 'b.yml')))
  assert.ok(!isInside(join(dir, 'a'), join(dir, 'b.yml')))
})

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0

test('git 检查：被跟踪的拒绝；没被忽略的拒绝；忽略且未跟踪的放行；仓库外放行', { skip: !hasGit }, () => {
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => spawnSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeFileSync(join(repo, '.gitignore'), 'secret.yml\n')
  writeFileSync(join(repo, 'tracked.yml'), 'x')
  git('add', '.gitignore', 'tracked.yml')
  git('commit', '-q', '-m', 'init')

  assert.match(gitProblem(join(repo, 'tracked.yml')), /tracked by git/)
  assert.match(gitProblem(join(repo, 'plain.yml')), /not ignored/)
  assert.equal(gitProblem(join(repo, 'secret.yml')), null)
  assert.equal(gitProblem(join(repo, 'nested', 'dir', 'secret.yml')), null, '父目录还不存在也能判断')

  const outside = join(dir, 'no-repo')
  mkdirSync(outside, { recursive: true })
  assert.equal(gitProblem(join(outside, 'config.yml')), null)
})

test('写入是原子的，写完能删', () => {
  const out = join(dir, 'written', 'config.yml')
  const fp = writeRendered(out, 'k: v\n')
  assert.match(fp, /^[0-9a-f]{8}$/)
  assert.equal(readFileSync(out, 'utf8'), 'k: v\n')
  assert.ok(removeRendered(out))
  assert.ok(!existsSync(out))
})
