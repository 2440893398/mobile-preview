import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  argvEqual, findApprovedUse, quoteForCmd, resolveExecutable, spawnArgv, tokenize,
} from '../src/argv.js'

test('tokenize 按空白切词，支持双引号、单引号与反斜杠转义', () => {
  assert.deepEqual(tokenize('npm run deploy'), ['npm', 'run', 'deploy'])
  assert.deepEqual(tokenize('node -e "console.log(1)"'), ['node', '-e', 'console.log(1)'])
  assert.deepEqual(tokenize("echo 'a b' c"), ['echo', 'a b', 'c'])
  assert.deepEqual(tokenize('a\\ b "c\\"d"'), ['a b', 'c"d'])
  assert.deepEqual(tokenize('  spaced   out  '), ['spaced', 'out'])
  assert.deepEqual(tokenize('x ""'), ['x', ''], '空引号是一个空参数，不是没有参数')
})

test('tokenize 对未闭合引号报错', () => {
  assert.throws(() => tokenize('echo "open'), /unbalanced/)
})

test('findApprovedUse 只接受逐项相等，不接受前缀或子串', () => {
  const uses = ['npm run deploy', 'node scripts/check-oss.js']
  assert.equal(findApprovedUse(uses, ['npm', 'run', 'deploy']), 'npm run deploy')
  assert.equal(findApprovedUse(uses, ['npm', 'run', 'deploy', '--', '--dump-env']), null)
  assert.equal(findApprovedUse(uses, ['npm', 'run']), null)
  assert.equal(findApprovedUse(uses, ['scripts/check-oss.js']), null)
  assert.equal(findApprovedUse([], ['npm']), null)
  assert.ok(argvEqual(['a'], ['a']))
  assert.ok(!argvEqual(['a'], ['a', 'b']))
})

test('quoteForCmd 只在需要时加引号，并按 C 运行时规则转义', () => {
  assert.equal(quoteForCmd('plain'), 'plain')
  assert.equal(quoteForCmd('has space'), '"has space"')
  assert.equal(quoteForCmd('a"b'), '"a\\"b"')
  assert.equal(quoteForCmd('trail\\'), 'trail\\', '不需要引号时结尾反斜杠也不用翻倍')
  assert.equal(quoteForCmd('tr ail\\'), '"tr ail\\\\"', '加了引号时结尾反斜杠必须翻倍，否则会吃掉闭引号')
  assert.equal(quoteForCmd('a&b'), '"a&b"')
  assert.equal(quoteForCmd(''), '""')
})

test('resolveExecutable 在 Windows 语义下按 PATHEXT 找到 .cmd，并标记为批处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-argv-'))
  try {
    writeFileSync(join(dir, 'npm.cmd'), '@echo off\r\n')
    // Node's installer puts an extensionless `npm` shell script beside npm.cmd.
    // It is a file, it is on PATH, and Windows cannot execute it.
    writeFileSync(join(dir, 'npm'), '#!/bin/sh\n')
    writeFileSync(join(dir, 'tool.exe'), '')
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }

    assert.deepEqual(resolveExecutable('npm', env, { win: true }), { file: join(dir, 'npm.cmd'), batch: true })
    assert.deepEqual(resolveExecutable('tool', env, { win: true }), { file: join(dir, 'tool.exe'), batch: false })
    assert.deepEqual(resolveExecutable('missing', env, { win: true }), { file: 'missing', batch: false })
    assert.deepEqual(resolveExecutable('npm', env, { win: false }), { file: 'npm', batch: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('spawnArgv 对批处理走 cmd.exe /d /s /c 且逐参数加引号，对可执行文件直接 spawn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-argv-'))
  try {
    writeFileSync(join(dir, 'npm.cmd'), '@echo off\r\n')
    writeFileSync(join(dir, 'node.exe'), '')
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\W\\cmd.exe' }
    const calls = []
    const spawnFn = (file, args, opts) => {
      calls.push({ file, args, opts })
      return {}
    }

    spawnArgv(['npm', 'run', 'deploy me'], { env, spawnFn, win: true })
    spawnArgv(['node', 'x.js'], { env, spawnFn, win: true })

    assert.equal(calls[0].file, 'C:\\W\\cmd.exe')
    assert.deepEqual(calls[0].args, ['/d', '/s', '/c', `"${join(dir, 'npm.cmd')} run "deploy me""`])
    assert.equal(calls[0].opts.windowsVerbatimArguments, true)
    assert.equal(calls[0].opts.shell, undefined, '永远不走 shell: true')

    assert.equal(calls[1].file, join(dir, 'node.exe'))
    assert.deepEqual(calls[1].args, ['x.js'])
    assert.equal(calls[1].opts.stdio[0], 'ignore', '子进程没有 stdin，避免交互式等待')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('spawnArgv 真的能跑起一个进程并注入环境变量', async () => {
  const child = spawnArgv([process.execPath, '-e', 'process.stdout.write(process.env.MP_T)'], {
    env: { ...process.env, MP_T: 'injected' },
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  await new Promise((r) => child.on('exit', r))
  assert.equal(out, 'injected')
})
