import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  REMOTE_CONTEXT,
  ancestorCommandLines,
  detectRemoteSession,
  hasHappyAncestor,
} from '../plugins/mobile-preview/hooks/session-start.mjs'
import { COMMANDS, commandGroup } from '../src/usage.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOOK = join(ROOT, 'plugins', 'mobile-preview', 'hooks', 'session-start.mjs')

// Windows 上 Happy 就是这样启动 Claude Code 的：SDK 的可执行文件在 happy 自己的
// 包里面。
const HAPPY_EXEC = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\happy\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
const LOCAL_EXEC = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'

// 每个用例自己给全环境，别让跑测试的那台机器（它自己就在 Happy 里）替它回答。
// CLAUDECODE 是 Claude Code 一定会设的，带上它才是「在 Claude Code 里」；Codex
// 的用例用 codexEnv()，那条路才会去翻进程树。
function env(extra) {
  return { PATH: '/usr/bin', CLAUDECODE: '1', ...extra }
}

function codexEnv(extra) {
  return { PATH: '/usr/bin', ...extra }
}

function runHook(extra) {
  return spawnSync(process.execPath, [HOOK], { env: env(extra), encoding: 'utf8' })
}

// 假的进程表：只回答「祖先的命令行是什么」，测试不碰真机器。
function fakeTree(lines) {
  return (file, args) => {
    if (file === 'powershell.exe') return lines.join('\r\n')
    if (file === 'ps') {
      const rows = ['  1000  999 ' + lines[0]]
      lines.slice(1).forEach((cmd, i) => rows.push(`  ${999 - i}  ${998 - i} ${cmd}`))
      return rows.join('\n')
    }
    return ''
  }
}

test('happy 起的会话：从 CLAUDE_CODE_EXECPATH 就能认出来', () => {
  assert.deepEqual(
    detectRemoteSession(env({ CLAUDE_CODE_EXECPATH: HAPPY_EXEC })),
    { remote: true, via: 'env' })
})

test('本地终端里的会话不是远程会话', () => {
  assert.equal(detectRemoteSession(env({ CLAUDE_CODE_EXECPATH: LOCAL_EXEC })).remote, false)
  assert.equal(detectRemoteSession(env({})).remote, false)
})

// 这一条是这个功能最容易写错的地方：装过 Happy 的机器，NO_PROXY 和 PATH 里都带
// 着 happy 的域名和路径。谁要是拿「环境变量里出现过 happy」当判据，本地终端里的
// 每一个会话都会被当成手机会话，然后每次开局都被塞一段用不上的提示。
test('装了 Happy 的机器，本地会话不能因为 NO_PROXY 里有 happy 就被认成远程', () => {
  const local = env({
    CLAUDE_CODE_EXECPATH: LOCAL_EXEC,
    NO_PROXY: 'localhost,127.0.0.1,::1,.local,happy.gcdev.dev',
    PATH: 'C:\\Users\\me\\AppData\\Roaming\\npm;C:\\tools\\happy\\bin',
  })

  assert.equal(detectRemoteSession(local).remote, false)
})

test('开发模式下 happy 不走那个包路径，但会导出 HAPPY_*', () => {
  const dev = env({ CLAUDE_CODE_EXECPATH: LOCAL_EXEC, HAPPY_PROJECT_ROOT: '/src/happy' })

  assert.equal(detectRemoteSession(dev).remote, true)
})

test('CLAUDE_CODE_ENTRYPOINT=remote_mobile 也算，但它靠不住所以只是兜底', () => {
  assert.equal(detectRemoteSession(env({ CLAUDE_CODE_ENTRYPOINT: 'remote_mobile' })).remote, true)
  // 真实的 happy 会话里这个值可能是继承来的 claude-desktop —— 当前这个会话就是。
  // 只认 entrypoint 的实现会漏掉它，所以 EXECPATH 那条必须单独成立。
  assert.equal(detectRemoteSession(env({
    CLAUDE_CODE_EXECPATH: HAPPY_EXEC,
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
  })).remote, true)
})

// ── Codex 那一侧 ──────────────────────────────────────────────────────────
// Codex 会话里没有任何环境痕迹：happy 是拿 `codex app-server` 驱动它的，环境是
// 原样继承的。唯一写着 happy 的地方是 rollout 文件的 originator，而实测那一行要
// 等 8–25 秒才落盘（本地会话只要 0.2 秒），hook 等不到。进程树是能立刻问到的。

test('Codex 会话：祖先里有 happy CLI 就是远程会话', () => {
  const chain = [
    'node "C:\\p\\hooks\\session-start.mjs"',
    'codex.exe app-server --listen stdio://',
    'node --no-warnings C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\happy\\dist\\index.mjs',
  ]

  assert.deepEqual(
    detectRemoteSession(codexEnv({}), { platform: 'win32', run: fakeTree(chain) }),
    { remote: true, via: 'process-tree' })
})

test('Codex 会话：祖先里没有 happy 就是本地会话', () => {
  const chain = [
    'node "C:\\p\\hooks\\session-start.mjs"',
    'codex.exe',
    'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]

  assert.equal(detectRemoteSession(codexEnv({}), { platform: 'win32', run: fakeTree(chain) }).remote, false)
})

// 翻进程树在 Windows 上要花将近一秒。Claude Code 的环境变量已经给出了确定答案，
// 本地会话不该为一次问不出新东西的扫描每次都等这一秒。
test('Claude Code 里不翻进程树——环境已经把话说死了', () => {
  let called = 0
  const run = () => { called += 1; return '' }

  assert.equal(detectRemoteSession(env({ CLAUDE_CODE_EXECPATH: LOCAL_EXEC }), { run }).remote, false)
  assert.equal(called, 0)
})

test('POSIX 上用 ps 的输出自己走祖先链，并且有深度上限', () => {
  const ps = [
    '  100   50 node /p/hooks/session-start.mjs',
    '   50   20 codex app-server --listen stdio://',
    '   20    1 node /usr/lib/node_modules/happy/dist/index.mjs',
    ' 4242    1 node /somewhere/else/unrelated.js',
  ].join('\n')

  const chain = ancestorCommandLines({ pid: 100, platform: 'linux', run: () => ps })

  assert.deepEqual(chain, [
    'node /p/hooks/session-start.mjs',
    'codex app-server --listen stdio://',
    'node /usr/lib/node_modules/happy/dist/index.mjs',
  ])
  assert.equal(hasHappyAncestor(chain), true)
})

test('查不到进程树时当本地会话处理，不能崩', () => {
  const run = () => { throw new Error('powershell is not on PATH') }

  assert.equal(ancestorCommandLines({ platform: 'win32', run: () => '' }).length, 0)
  assert.equal(detectRemoteSession(codexEnv({}), { platform: 'linux', run: () => '' }).remote, false)
  assert.doesNotThrow(() => hasHappyAncestor([]))
  assert.equal(typeof run, 'function')
})

// 名字里带 happy 的项目目录不该把人的本地会话变成手机会话。
test('happy-app 这样的目录名不算 happy 进程', () => {
  assert.equal(hasHappyAncestor(['node C:\\projects\\happy-app\\server.js']), false)
  assert.equal(hasHappyAncestor(['C:\\Users\\me\\AppData\\Roaming\\npm\\happy.cmd claude']), true)
  assert.equal(hasHappyAncestor(['node /usr/lib/node_modules/happy/dist/index.mjs']), true)
})

test('远程会话里，hook 输出两个宿主都认的那种上下文注入 JSON', () => {
  const res = runHook({ CLAUDE_CODE_EXECPATH: HAPPY_EXEC })

  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(out.hookSpecificOutput.additionalContext, REMOTE_CONTEXT)
})

test('本地会话里 hook 一声不吭，且退出码为 0', () => {
  const res = runHook({ CLAUDE_CODE_EXECPATH: LOCAL_EXEC })

  assert.equal(res.status, 0, res.stderr)
  assert.equal(res.stdout.trim(), '')
})

test('注入的文字要说清「不许直接给 localhost」和「用 mp start」', () => {
  assert.match(REMOTE_CONTEXT, /localhost/)
  assert.match(REMOTE_CONTEXT, /mp start --port/)
  assert.match(REMOTE_CONTEXT, /mp capture/)
  assert.match(REMOTE_CONTEXT, /bare line/, '手机客户端里代码块中的链接点不了也复制不了')
})

// 这段文字是每个远程会话开局都会读到的，它教的命令必须是 CLI 真认的命令——
// 文档那边已经有同样的约束（tests/usage.test.js），这里补上 hook 这一份。
test('注入的文字里教的 mp 命令和参数都真实存在', () => {
  for (const [, name] of REMOTE_CONTEXT.matchAll(/`mp(?:\.cmd)? ([a-z]+(?: [a-z]+)?)/g)) {
    // "mp secret ask" 是命令组 + 子命令；"mp secret wait" 后面跟着别的词时只匹配到组名。
    const known = COMMANDS[name] || COMMANDS[name.split(' ')[0]] || commandGroup(name.split(' ')[0]).length
    assert.ok(known, `hook 教了 mp ${name}，但 CLI 没有这个子命令`)
  }
  const supported = new Set(Object.values(COMMANDS).flatMap((s) => Object.keys(s.flags)))
  for (const [, flag] of REMOTE_CONTEXT.matchAll(/`--([a-z][a-z0-9-]*)/g)) {
    assert.ok(supported.has(flag), `hook 教了 --${flag}，但 CLI 不认识它`)
  }
})

// hooks.json 写错了不会报错，只会安静地什么都不做——那正是最难发现的失败方式。
// 位置也是约定的一部分：Claude Code 和 Codex 都自动发现 <plugin>/hooks/hooks.json，
// 挪个地方就等于把这个功能关掉。
test('hooks.json 在两个宿主都自动发现的位置，挂在 SessionStart 上，指向真实存在的脚本', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'plugins', 'mobile-preview', 'hooks', 'hooks.json'), 'utf8'))
  const entry = hooks.hooks.SessionStart[0]

  assert.equal(entry.matcher, undefined,
    '不写 matcher 才能覆盖 startup/resume/clear/compact 以及以后新增的来源')
  assert.match(entry.hooks[0].command, /session-start\.mjs/)
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/,
    '写死绝对路径的 hook 换台机器就废了；Codex 也认这个变量名')

  // 密钥那一路的 deny 挂在 PreToolUse 上，只看 Bash 与 PowerShell：hook 的 deny 是
  // bypassPermissions 模式下唯一还生效的强制手段（设计 §2.1），挂错事件等于没挂。
  const pre = hooks.hooks.PreToolUse[0]
  assert.equal(pre.matcher, 'Bash|PowerShell')
  assert.match(pre.hooks[0].command, /pre-tool-use\.mjs/)
  assert.match(pre.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/)
  assert.ok(existsSync(join(ROOT, 'plugins', 'mobile-preview', 'hooks', 'pre-tool-use.mjs')))

  // 两边都靠自动发现。谁要是再在 manifest 里显式指一遍同一个文件，就有可能被
  // 注册两次、同一段话注入两次。
  for (const dir of ['.claude-plugin', '.codex-plugin']) {
    const manifest = JSON.parse(readFileSync(
      join(ROOT, 'plugins', 'mobile-preview', dir, 'plugin.json'), 'utf8'))
    assert.equal(manifest.hooks, undefined, `${dir}/plugin.json 不该再显式声明 hooks 路径`)
  }
})
