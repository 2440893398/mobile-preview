import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mp-state-'))
process.env.MP_STATE_DIR = dir

const {
  read, write, clear, list,
  statePath, tunnelLogPath, galleryDir, previewsDir, legacyStatePath,
} = await import('../src/state.js')

test('每条预览的状态文件以端口命名，放在 previews 目录下', () => {
  assert.equal(previewsDir(), join(dir, 'previews'))
  assert.equal(statePath(4321), join(dir, 'previews', '4321.json'))
})

test('隧道日志与状态文件同目录，按端口区分', () => {
  assert.equal(tunnelLogPath(4321), join(dir, 'previews', '4321.cloudflared.log'))
})

test('产物目录按端口分开', () => {
  assert.equal(galleryDir(4321), join(dir, 'gallery', '4321'))
  assert.notEqual(galleryDir(4321), galleryDir(3000))
})

test('遗留的单槽状态文件仍在根目录', () => {
  assert.equal(legacyStatePath(), join(dir, 'state.json'))
})

test('没有状态文件时 read 返回 null', () => {
  assert.equal(read(4321), null)
})

test('write 后 read 能读回', () => {
  write(4321, { tunnelUrl: 'https://a.trycloudflare.com', ttl: 30 })
  assert.equal(read(4321).tunnelUrl, 'https://a.trycloudflare.com')
  assert.equal(read(4321).ttl, 30)
})

test('write 是合并而非替换', () => {
  write(4321, { proxyPort: 41234 })
  const s = read(4321)
  assert.equal(s.proxyPort, 41234)
  assert.equal(s.tunnelUrl, 'https://a.trycloudflare.com')
})

test('两个端口的状态互不干扰', () => {
  write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })
  assert.equal(read(4321).tunnelUrl, 'https://a.trycloudflare.com')
  assert.equal(read(3000).tunnelUrl, 'https://b.trycloudflare.com')
})

test('clear 只删指定端口', () => {
  write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })
  clear(3000)
  assert.equal(read(3000), null)
  assert.equal(read(4321).tunnelUrl, 'https://a.trycloudflare.com')
})

test('clear 对不存在的预览是无操作', () => {
  clear(9999)
  assert.equal(read(9999), null)
})

test('list 返回全部预览并按端口升序', () => {
  write(3000, { tunnelUrl: 'https://b.trycloudflare.com' })
  write(8080, { tunnelUrl: 'https://c.trycloudflare.com' })
  const ports = list().map((s) => s.targetPort)
  assert.deepEqual(ports, [3000, 4321, 8080])
})

test('list 给出的 targetPort 是数字，以文件名为准', () => {
  write(3000, { targetPort: 'nonsense' })
  const found = list().find((s) => s.targetPort === 3000)
  assert.equal(typeof found.targetPort, 'number')
})

test('list 跳过损坏的 json 而不抛异常', () => {
  writeFileSync(join(previewsDir(), '7777.json'), '{ not json', 'utf8')
  const ports = list().map((s) => s.targetPort)
  assert.ok(!ports.includes(7777), '损坏条目不应出现在结果里')
  assert.ok(ports.includes(4321), '其余条目仍应返回')
})

test('list 跳过文件名不是纯数字的条目', () => {
  writeFileSync(join(previewsDir(), 'notes.json'), '{"tunnelUrl":"x"}', 'utf8')
  writeFileSync(join(previewsDir(), '4321.cloudflared.log'), 'INF x', 'utf8')
  assert.equal(list().filter((s) => Number.isNaN(s.targetPort)).length, 0)
})

test('previews 目录不存在时 list 返回空数组', () => {
  const empty = mkdtempSync(join(tmpdir(), 'mp-state-empty-'))
  const prev = process.env.MP_STATE_DIR
  process.env.MP_STATE_DIR = empty
  try {
    assert.deepEqual(list(), [])
  } finally {
    process.env.MP_STATE_DIR = prev
    rmSync(empty, { recursive: true, force: true })
  }
})

test('read 遇到损坏 json 返回 null 而非抛异常', () => {
  mkdirSync(previewsDir(), { recursive: true })
  writeFileSync(statePath(5555), '{ not json', 'utf8')
  assert.equal(read(5555), null)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
