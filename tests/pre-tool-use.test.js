import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { argvAfterSeparator, decide, splitPipeline } from '../plugins/mobile-preview/hooks/pre-tool-use.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOOK = join(ROOT, 'plugins', 'mobile-preview', 'hooks', 'pre-tool-use.mjs')

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } })
const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } })

test('与 mp secret run 无关的命令一律不管', () => {
  assert.equal(decide(bash('cat .env')), null)
  assert.equal(decide(bash('mp start --port 5173')), null)
  assert.equal(decide(bash('env | sort')), null)
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: '.env' } }), null)
})

test('正常的用法放行：直接跑工具或脚本文件', () => {
  assert.equal(decide(bash('mp secret run --id s-7f3a1c -- npm run deploy')), null)
  assert.equal(decide(ps('mp.cmd secret run -- node scripts/check-oss.js')), null)
  assert.equal(decide(bash('mp secret run -- ossutil cp ./dist oss://bucket/ -r')), null)
  assert.equal(decide(bash('mp secret run -- python manage.py migrate')), null)
})

test('解释器带内联代码被拒', () => {
  for (const cmd of [
    'mp secret run -- sh -c "echo $OSS_SECRET"',
    'mp secret run -- bash -c env',
    'mp.cmd secret run -- cmd /c set',
    'mp.cmd secret run -- powershell -Command "gci env:"',
    'mp secret run -- node -e "console.log(process.env)"',
    'mp secret run -- python -c "import os; print(os.environ)"',
    'mp secret run -- C:\\Windows\\System32\\cmd.exe /c set',
  ]) {
    const v = decide(bash(cmd))
    assert.ok(v?.deny, `应当拒绝：${cmd}`)
    assert.match(v.deny, /inline code|environment/)
  }
})

test('argv 里出现环境导出形态被拒', () => {
  for (const cmd of [
    'mp secret run -- printenv',
    'mp secret run -- set',
    'mp.cmd secret run -- Get-ChildItem env:',
    'mp secret run -- echo $OSS_SECRET',
    'mp.cmd secret run -- echo %OSS_SECRET%',
    'mp.cmd secret run -- Write-Output $env:OSS_SECRET',
  ]) {
    const v = decide(bash(cmd))
    assert.ok(v?.deny, `应当拒绝：${cmd}`)
  }
})

test('argvAfterSeparator 只看 -- 之后，并尊重引号', () => {
  assert.deepEqual(argvAfterSeparator('mp secret run --id s-1 -- node "a b.js"'), ['node', 'a b.js'])
  assert.deepEqual(argvAfterSeparator('mp secret run --id s-1'), [])
})

// 真机实测撞上的误报（2026-09-11）：`--` 之后跟了一句 PowerShell 后续语句，
// 整句被当成 argv，里面的 $LASTEXITCODE 触发了环境导出规则。argv 到第一个
// 未被引号包住的 shell 操作符就结束了——shell 自己也是这么断的。
test('argv 在未加引号的 shell 操作符处结束：后面的语句不算 argv', () => {
  assert.equal(decide(bash('mp.cmd secret run -- node check.mjs; "exit: $LASTEXITCODE"')), null)
  assert.equal(decide(bash('mp secret run -- npm run deploy && echo done')), null)
  assert.equal(decide(bash('mp secret run -- npm run deploy > out.txt')), null, '输出已经脱敏，落盘无妨')
  assert.equal(decide(bash('mp secret run -- node "a;b.js"')), null, '引号里的分号不是操作符')
})

test('splitPipeline 按未加引号的操作符切段并记下操作符', () => {
  const segs = splitPipeline('mp secret run -- a | base64')
  assert.equal(segs.length, 2)
  assert.equal(segs[1].opBefore, '|')
  assert.match(segs[1].text, /base64/)
  assert.equal(splitPipeline('echo "a | b"').length, 1)
})

// 设计 §6.1 的第二条规则：脱敏发生在 daemon 输出的那一刻，把输出再管道给一个
// 编码器就得到了 daemon 没见过的形态。
test('把 run 的输出管道给编码器被拒', () => {
  for (const cmd of [
    'mp secret run -- npm run deploy | base64',
    'mp secret run -- npm run deploy | certutil -encode - out.txt',
    'mp secret run -- npm run deploy | xxd',
    'mp.cmd secret run -- npm run deploy | Format-Hex',
    'mp.cmd secret run -- npm run deploy | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) }',
  ]) {
    const v = decide(bash(cmd))
    assert.ok(v?.deny, `应当拒绝：${cmd}`)
    assert.match(v.deny, /re-encode/)
  }

  assert.equal(decide(bash('mp secret run -- npm run deploy | Select-String error')), null,
    '只是筛选输出，不是重新编码')
})

test('作为 hook 进程运行：拒绝时输出 PreToolUse deny，放行时什么都不输出', () => {
  const deny = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(bash('mp secret run -- sh -c "env"')), encoding: 'utf8',
  })
  assert.equal(deny.status, 0)
  const out = JSON.parse(deny.stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /inline code/)

  const allow = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(bash('mp secret run -- npm run deploy')), encoding: 'utf8',
  })
  assert.equal(allow.status, 0)
  assert.equal(allow.stdout, '')

  const garbage = spawnSync(process.execPath, [HOOK], { input: '{ nope', encoding: 'utf8' })
  assert.equal(garbage.status, 0, '坏输入也不能让工具调用失败')
  assert.equal(garbage.stdout, '')
})

test('stdin 一直不关也会自己了结，而不是挂到 hook 超时被杀', async () => {
  // 宿主要是把继承来的终端交给它，这个读就永远等不到 end。那种失效是看不见的：
  // 没有报错、没有输出，这道在 bypassPermissions 下唯一还生效的闸直接消失。
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.write(JSON.stringify(bash('mp secret run -- sh -c "env"')))
  // 故意不 end()。

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('hook 没有在 5 秒内退出')) }, 5_000)
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d })
    child.on('close', (status) => {
      clearTimeout(timer)
      assert.match(out, /inline code/, '超时读到的那半截也该照常判')
      resolve(status)
    })
    child.on('error', reject)
  })
  assert.equal(code, 0)
})
