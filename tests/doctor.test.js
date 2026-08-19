import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDoctor, runChecks } from '../src/doctor.js'

// Every probe is injected: the classification is the part that has actually
// been wrong in the field (a linked-but-not-on-PATH CLI reported as a missing
// cloudflared), and it must be checkable without a particular machine's
// software installed.
function checksWith(overrides) {
  return runChecks({
    resolveCommand: () => null,
    globalNpmRoot: () => null,
    findCloudflared: () => null,
    findPlaywrightChromium: () => null,
    findBrowserExecutable: () => null,
    browsersDir: () => '/browsers',
    exists: () => false,
    ...overrides,
  })
}

function byId(checks, id) {
  return checks.find((c) => c.id === id)
}

test('一切齐备时四项全绿', () => {
  const checks = checksWith({
    resolveCommand: (n) => `/usr/bin/${n}`,
    findCloudflared: () => '/usr/bin/cloudflared',
    findPlaywrightChromium: () => '/browsers/chromium-1200',
  })

  assert.equal(checks.every((c) => c.ok), true, JSON.stringify(checks, null, 2))
  assert.match(formatDoctor(checks, { win: false }), /Everything mp needs is present/)
})

test('CLI 根本没装：给的是 npm link，不是「重装 cloudflared」', () => {
  const cli = byId(checksWith({}), 'cli')

  assert.equal(cli.ok, false)
  assert.match(cli.detail, /not installed/)
  assert.match(cli.fix, /npm link/)
})

test('CLI 装了但当前 shell 看不到：区分出来，并指向 PATH 而不是重装', () => {
  const cli = byId(checksWith({
    globalNpmRoot: () => '/npm/lib/node_modules',
    exists: (p) => p.includes('mobile-preview'),
  }), 'cli')

  assert.equal(cli.ok, false)
  assert.match(cli.detail, /linked at .*mobile-preview/)
  assert.match(cli.detail, /not resolvable on PATH/)
  assert.match(cli.fix, /PATH|new shell/i)
  assert.doesNotMatch(cli.fix, /npm link/, '已经 link 过了，再让人 link 一次是把人往沟里带')
})

test('cloudflared 缺失时给出可以直接粘的安装命令', () => {
  const cf = byId(checksWith({}), 'cloudflared')

  assert.equal(cf.ok, false)
  assert.match(cf.fix, /winget install --id Cloudflare\.cloudflared/)
})

test('Playwright 浏览器没下，但系统有 Chrome：算通过，并说清用的是哪个', () => {
  const chromium = byId(checksWith({
    findBrowserExecutable: () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  }), 'chromium')

  assert.equal(chromium.ok, true, 'capture 确实能跑，就不该报缺失让人白下 150MB')
  assert.match(chromium.detail, /fall back to .*chrome\.exe/)
})

test('浏览器一个都没有时点名 capture 跑不了，并给出下载命令', () => {
  const chromium = byId(checksWith({}), 'chromium')

  assert.equal(chromium.ok, false)
  assert.match(chromium.detail, /mp capture cannot run/)
  assert.match(chromium.fix, /playwright install chromium/)
})

test('ffmpeg 只影响 --video，缺了不算致命', () => {
  const checks = checksWith({
    resolveCommand: (n) => (n === 'ffmpeg' ? null : `/usr/bin/${n}`),
    findCloudflared: () => '/usr/bin/cloudflared',
    findPlaywrightChromium: () => '/browsers/chromium-1200',
  })
  const ff = byId(checks, 'ffmpeg')

  assert.equal(ff.ok, false)
  assert.equal(ff.optional, true)
  assert.match(ff.detail, /only .*--video/)
  assert.match(formatDoctor(checks, { win: false }), /Everything mp needs is present/,
    '可选项缺失不该把整体判成不可用')
})

test('formatDoctor 逐条给出修复命令，并统计真正阻塞的项目', () => {
  const out = formatDoctor(checksWith({}), { win: false })

  assert.match(out, /MISSING/)
  assert.match(out, /fix:/)
  assert.match(out, /3 required item\(s\) missing/)
})

test('Windows 上必须提醒 PowerShell 的 mp 别名', () => {
  const out = formatDoctor(checksWith({}), { win: true })

  assert.match(out, /Move-ItemProperty/)
  assert.match(out, /mp\.cmd/)
})
