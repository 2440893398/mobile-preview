import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { COMMANDS, VERSION, renderCommandHelp, renderHelp } from '../src/usage.js'

const BIN = fileURLToPath(new URL('../src/bin.js', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))

function mp(args) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-usage-'))
  try {
    return spawnSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, MP_STATE_DIR: dir },
      encoding: 'utf8',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readRoot(...parts) {
  return readFileSync(join(ROOT, ...parts), 'utf8')
}

test('mp --version 打印版本号并成功退出（不再是 usage + 退出码 1）', () => {
  const res = mp(['--version'])

  assert.equal(res.status, 0)
  assert.equal(res.stdout.trim(), VERSION)
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
})

test('mp -v 与 mp version 是同一件事', () => {
  assert.equal(mp(['-v']).stdout.trim(), VERSION)
  assert.equal(mp(['version']).stdout.trim(), VERSION)
})

test('mp --help 列出全部子命令与全局选项', () => {
  const res = mp(['--help'])

  assert.equal(res.status, 0)
  for (const name of Object.keys(COMMANDS)) {
    assert.match(res.stdout, new RegExp(`\\b${name}\\b`), `帮助里必须有 ${name}`)
  }
  assert.match(res.stdout, /--version/)
  assert.match(res.stdout, /mp\.cmd/, 'PowerShell 的 mp 别名坑必须写在最显眼的地方')
})

test('不带参数的 mp 给帮助，而不是一行 usage', () => {
  const res = mp([])

  assert.equal(res.status, 0)
  assert.match(res.stdout, /commands:/)
})

test('mp capture --help 只打印帮助，绝不真的去截图', () => {
  // 此前 `mp capture --help` 会把 --help 当成布尔开关吞掉，然后照常截图；
  // 在没有活预览时它甚至会以「no active preview」失败——两种都不是帮助。
  const res = mp(['capture', '--help'])

  assert.equal(res.status, 0, `实得 ${res.status}: ${res.stderr}`)
  assert.match(res.stdout, /--wait-for/)
  assert.match(res.stdout, /--full-page/)
  assert.doesNotMatch(res.stderr, /no active preview/)
})

test('每个子命令都有自己的帮助，且列全它接受的参数', () => {
  for (const [name, spec] of Object.entries(COMMANDS)) {
    const res = mp([name, '--help'])
    assert.equal(res.status, 0, `mp ${name} --help 应当成功: ${res.stderr}`)
    for (const flag of Object.keys(spec.flags)) {
      assert.match(res.stdout, new RegExp(`--${flag}\\b`), `mp ${name} --help 少了 --${flag}`)
    }
  }
})

test('未知参数直接报错并点名，不再被当成布尔开关吞掉', () => {
  const res = mp(['start', '--porrt', '4173'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /unknown option --porrt/)
  assert.match(res.stderr, /--port/, '必须顺带列出它到底接受什么')
})

test('把别的子命令的参数用错地方也会被拦下', () => {
  const res = mp(['status', '--dev'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /unknown option --dev/)
})

test('开关参数不接受赋值形式，避免 --dev=false 被读成真', () => {
  const res = mp(['start', '--dev=false'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /switch and takes no value/)
})

test('--port=4173 这种写法照常接受', () => {
  const res = mp(['start', '--port=99999'])

  // 走到了范围校验，说明 = 形式确实被解析成了值
  assert.equal(res.status, 1)
  assert.match(res.stderr, /--port must be between 1 and 65535/)
})

test('多余的位置参数会被拒绝，而不是默默忽略', () => {
  const res = mp(['status', 'extra'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /unexpected argument "extra"/)
})

test('未知子命令报错并给出完整帮助', () => {
  const res = mp(['strat'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /unknown command "strat"/)
  assert.match(res.stderr, /commands:/)
})

test('renderCommandHelp 对未知命令返回 null 而不是编一段出来', () => {
  assert.equal(renderCommandHelp('nope'), null)
  assert.match(renderHelp(), /^mp — /)
})

// ---- 版本与文档同步 ----

// 同一个版本号现在落在四个地方：CLI 的 package.json、Codex 的 plugin.json、
// Claude Code 的 plugin.json，以及 Claude Code 的 marketplace 清单。四份手抄
// 的数字迟早会对不上——那正是「拿到 0.1.1 的文档、跑着 0.1.0 的 CLI」那次的
// 成因，所以这里把它们钉在一起。
const VERSIONED_MANIFESTS = [
  [['plugins', 'mobile-preview', '.codex-plugin', 'plugin.json'], (j) => j.version],
  [['plugins', 'mobile-preview', '.claude-plugin', 'plugin.json'], (j) => j.version],
  [['.claude-plugin', 'marketplace.json'], (j) => j.plugins[0].version],
]

test('CLI 与每一份插件 manifest 的版本必须一致', () => {
  for (const [parts, pick] of VERSIONED_MANIFESTS) {
    const json = JSON.parse(readRoot(...parts))
    assert.equal(pick(json), VERSION,
      `${parts.join('/')} 的版本与 CLI 不一致：用户拿到的文档与 skill 来自插件包，`
      + '执行的却是 CLI，对不上时没人说得清手上跑的是哪一版')
  }
})

test('两个插件系统指向同一个插件目录与同一份 skill', () => {
  const codex = JSON.parse(readRoot('.agents', 'plugins', 'marketplace.json'))
  const claude = JSON.parse(readRoot('.claude-plugin', 'marketplace.json'))

  assert.equal(codex.plugins[0].source.path, './plugins/mobile-preview')
  assert.equal(claude.plugins[0].source, './plugins/mobile-preview',
    '两边各自维护一份 skill 就是又一次抄写漂移；必须是同一个目录')
  assert.equal(codex.plugins[0].name, claude.plugins[0].name)
})

test('插件自带的预检脚本用的是 CLI 那份 doctor，不是它自己的降级实现', () => {
  // 这一条是真出过事的：脚本里的 `import('mobile-preview/doctor')` 在全局
  // npm link 下解析不到（Node 不搜全局 node_modules），于是每次都悄悄掉进
  // 降级分支——而降级分支只查 PATH，把装在 Program Files 里的 cloudflared
  // 报成缺失。cwd 特意设在别处，证明它靠的不是当前目录碰巧对了。
  const script = join(ROOT, 'plugins', 'mobile-preview', 'scripts', 'check-prerequisites.mjs')
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: tmpdir() })

  assert.match(res.stdout, /Playwright Chromium/,
    '只有共享的 doctor 会检查浏览器；降级实现根本没有这一项')
  assert.doesNotMatch(res.stdout, /could not be imported/,
    '能解析到 CLI 时就不该报「导入不了」')
})

test('Claude Code 与 Codex 的 manifest 描述同一个插件', () => {
  const codex = JSON.parse(readRoot('plugins', 'mobile-preview', '.codex-plugin', 'plugin.json'))
  const claude = JSON.parse(readRoot('plugins', 'mobile-preview', '.claude-plugin', 'plugin.json'))

  assert.equal(claude.name, codex.name)
  assert.equal(claude.description, codex.description)
})

// 文档里教用户敲的每一个 mp 参数，都必须是 CLI 真的认的参数。
// 反过来漏写不算错（帮助文本才是权威），但教一个不存在的参数一定是错。
const DOC_FILES = [
  ['README.md'],
  ['skill', 'SKILL.md'],
  ['plugins', 'mobile-preview', 'README.md'],
  ['plugins', 'mobile-preview', 'skills', 'mobile-preview', 'SKILL.md'],
]

function documentedFlags(text) {
  const found = new Set()
  for (const line of text.split(/\r?\n/)) {
    // 只看教人怎么敲的行：mp 开头的命令行，和参数表格的行首。
    const isCommandLine = /(^|\s)mp(\.cmd)?\s/.test(line)
    const tableFlag = /^\|\s*`--([a-z][a-z0-9-]*)`/.exec(line)
    if (tableFlag) found.add(tableFlag[1])
    if (!isCommandLine) continue
    for (const m of line.matchAll(/--([a-z][a-z0-9-]*)/g)) found.add(m[1])
  }
  return found
}

test('文档里出现的 mp 参数都是 CLI 真的支持的参数', () => {
  const supported = new Set(['help', 'version'])
  for (const spec of Object.values(COMMANDS)) {
    for (const flag of Object.keys(spec.flags)) supported.add(flag)
  }

  for (const parts of DOC_FILES) {
    for (const flag of documentedFlags(readRoot(...parts))) {
      assert.ok(supported.has(flag),
        `${parts.join('/')} 教了 --${flag}，但 CLI 不认识它`)
    }
  }
})

test('README 的参数表覆盖 mp start 的每一个参数', () => {
  const readme = readRoot('README.md')
  for (const flag of Object.keys(COMMANDS.start.flags)) {
    assert.match(readme, new RegExp(`\\|\\s*\`--${flag}\``), `README 的表里少了 --${flag}`)
  }
})

test('文档一律使用 __mp_token，不再把 ?t= 当作默认形式', () => {
  for (const parts of DOC_FILES) {
    const text = readRoot(...parts)
    if (!/mp_token|\?t=/.test(text)) continue
    assert.match(text, /__mp_token/, `${parts.join('/')} 必须写明新的参数名`)
  }
})
