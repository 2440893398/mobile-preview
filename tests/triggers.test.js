import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { REMOTE_CONTEXT } from '../plugins/mobile-preview/hooks/session-start.mjs'
import { decide as askDecide, shapeOf } from '../plugins/mobile-preview/hooks/ask-question.mjs'
import {
  decide as stopDecide, handsOverLocalAddress, looksLikeAnUnansweredDecision,
} from '../plugins/mobile-preview/hooks/stop.mjs'
import {
  desktopSessionFile, hasOpenInteraction, isRemoteNow, pruneMarks, readMark, remoteStatus, sessionsDir,
  steeredFromPhone, writeMark,
} from '../plugins/mobile-preview/hooks/session-mark.mjs'
import { readPayload } from '../plugins/mobile-preview/hooks/hook-io.mjs'
import { confirmedRemoteAnswer } from '../plugins/mobile-preview/hooks/manual-confirm.mjs'
import { COMMANDS, commandGroup } from '../src/usage.js'

// 三层触发的目的只有一句话：AI 该在需要人判断的那一刻自己开页面，而不是先输出
// 长文、再等用户开口说「用插件处理一下」。这里守的是三层各自的边界——尤其是
// 「什么时候不该动」，因为一个爱管闲事的 hook 会被绕开，那等于没有。

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOOKS = join(ROOT, 'plugins', 'mobile-preview', 'hooks')

function tempEnv() {
  return { MP_STATE_DIR: mkdtempSync(join(tmpdir(), 'mp-trigger-')) }
}

function runHook(file, payload, extra = {}) {
  return spawnSync(process.execPath, [join(HOOKS, file)], {
    env: { PATH: process.env.PATH, CLAUDECODE: '1', ...extra },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
}

// ---- 第一层：SessionStart 注入 ----

test('注入的文字教了 interaction 的两条命令，且它们真的存在', () => {
  assert.match(REMOTE_CONTEXT, /mp interaction ask/)
  assert.match(REMOTE_CONTEXT, /mp interaction wait/)

  for (const [, name] of REMOTE_CONTEXT.matchAll(/`mp(?:\.cmd)? ([a-z]+(?: [a-z]+)?)/g)) {
    const known = COMMANDS[name] || COMMANDS[name.split(' ')[0]] || commandGroup(name.split(' ')[0]).length
    assert.ok(known, `hook 教了 mp ${name}，但 CLI 没有这个子命令`)
  }
})

test('注入的文字说清了什么时候开页面、什么时候留在聊天里', () => {
  assert.match(REMOTE_CONTEXT, /three or more options/)
  assert.match(REMOTE_CONTEXT, /ordering/)
  assert.match(REMOTE_CONTEXT, /single yes\/no/, '简单问题必须明确留在聊天里，否则每件小事都要开页面')
  assert.match(REMOTE_CONTEXT, /"waiting"/, '续等规则要写进去，否则超时一次就当失败了')
})

// 这段文字每个远程会话开局都要读一遍，压缩后还要再读一遍。它是有成本的。
test('注入的文字没有失控地变长', () => {
  const words = REMOTE_CONTEXT.split(/\s+/).length
  // 400 → 420：「页面要画出来，不是把话搬过去」这条必须在注入里。它决定页面
  // 值不值得开，而只读注入的模型——注入已经够它跑完命令——永远不会去加载
  // skill，细节挪进去就等于没有。
  assert.ok(words < 420, `注入已经涨到 ${words} 个词；超过 420 就该把细节挪进 skill`)
})

test('SessionStart 在远程会话里记下会话，本地会话也记——「不是远程」同样是答案', () => {
  const env = tempEnv()
  const HAPPY = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\happy\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'

  const remote = runHook('session-start.mjs', { session_id: 'sess-remote' }, { ...env, CLAUDE_CODE_EXECPATH: HAPPY })
  assert.equal(remote.status, 0, remote.stderr)
  assert.equal(JSON.parse(remote.stdout).hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(readMark('sess-remote', env).remote, true)

  const local = runHook('session-start.mjs', { session_id: 'sess-local' }, env)
  assert.equal(local.status, 0, local.stderr)
  assert.equal(local.stdout.trim(), '', '本地会话仍然一声不吭')
  assert.equal(readMark('sess-local', env).remote, false)
})

test('没有 session_id 也不能让 SessionStart 出错——注入照样送出去', () => {
  const env = tempEnv()
  const HAPPY = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\happy\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
  const res = runHook('session-start.mjs', {}, { ...env, CLAUDE_CODE_EXECPATH: HAPPY })

  assert.equal(res.status, 0, res.stderr)
  assert.ok(JSON.parse(res.stdout).hookSpecificOutput.additionalContext)
})

// ---- 会话标记 ----

test('会话标记能写能读，过期的读不到', () => {
  const env = tempEnv()
  assert.equal(readMark('s1', env), null)

  writeMark('s1', { remote: true, via: 'env', blocks: 0 }, env)
  assert.equal(readMark('s1', env).remote, true)

  writeMark('s1', { blocks: 2 }, env)
  const merged = readMark('s1', env)
  assert.equal(merged.blocks, 2)
  assert.equal(merged.remote, true, '部分更新不能把别的字段抹掉')

  const f = join(sessionsDir(env), 's1.json')
  writeFileSync(f, JSON.stringify({ remote: true, at: Date.now() - 48 * 60 * 60_000 }), 'utf8')
  assert.equal(readMark('s1', env), null, '两天前的会话不该还在替今天的会话回答')

  writeFileSync(f, JSON.stringify({ manualRemote: true, at: Date.now() - 48 * 60 * 60_000 }), 'utf8')
  assert.equal(readMark('s1', env).manualRemote, true, '手动选择不能在活跃长会话的一天后消失')
})

test('SessionStart 恢复会话时保留用户已确认的远端选择', () => {
  const env = tempEnv()
  writeMark('s-resumed', { manualRemote: true, blocks: 1 }, env)
  const resumed = runHook('session-start.mjs', { session_id: 's-resumed' }, env)
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.equal(readMark('s-resumed', env).manualRemote, true)
  assert.equal(remoteStatus(readMark('s-resumed', env), env).remote, true)
})

test('手动确认的远端或本机选择按会话保存，Happy 和 Claude 手机信号仍可直接判定', () => {
  const env = tempEnv()
  assert.deepEqual(remoteStatus(null, env), { remote: false, confirmed: false })
  writeMark('manual', { remote: false, manualRemote: false }, env)
  assert.deepEqual(remoteStatus(readMark('manual', env), env), { remote: false, confirmed: true })
  writeMark('manual', { manualRemote: true }, env)
  assert.deepEqual(remoteStatus(readMark('manual', env), env), { remote: true, confirmed: true })
  assert.deepEqual(remoteStatus({ remote: true, manualRemote: false }, env), { remote: true, confirmed: true })
})

test('mp remote on/off 只改当前 Codex 会话的手动选择，且缺少会话 ID 时拒绝写入', () => {
  const env = tempEnv()
  const cli = join(ROOT, 'src', 'bin.js')
  const run = (args, sessionId = 'codex-manual') => spawnSync(process.execPath, [cli, 'remote', ...args], {
    env: { ...process.env, ...env, CODEX_SESSION_ID: sessionId, CODEX_THREAD_ID: sessionId },
    encoding: 'utf8',
  })

  const on = run(['on'])
  assert.equal(on.status, 0, on.stderr)
  assert.equal(readMark('codex-manual', env).manualRemote, true)
  assert.equal(readMark('codex-manual', env).awaitingManualRemote, false)
  const off = run(['off'])
  assert.equal(off.status, 0, off.stderr)
  assert.equal(readMark('codex-manual', env).manualRemote, false)
  const missing = run(['on'], '')
  assert.notEqual(missing.status, 0)
  assert.equal(readMark('codex-manual', env).manualRemote, false)
})

test('只接受待确认问题的明确短答，自动记住选择；其他文字不触发', () => {
  const env = tempEnv()
  assert.equal(confirmedRemoteAnswer('远端'), true)
  assert.equal(confirmedRemoteAnswer('本机'), false)
  assert.equal(confirmedRemoteAnswer('本机地址是 localhost'), null)

  writeMark('s-answer', { remote: false, awaitingManualRemote: true }, env)
  const unrelated = runHook('manual-confirm.mjs', { session_id: 's-answer', prompt: '本机地址是 localhost' }, env)
  assert.equal(unrelated.status, 0, unrelated.stderr)
  assert.equal(readMark('s-answer', env).manualRemote, undefined)

  const reply = runHook('manual-confirm.mjs', { session_id: 's-answer', prompt: '远端' }, env)
  assert.equal(reply.status, 0, reply.stderr)
  assert.match(JSON.parse(reply.stdout).hookSpecificOutput.additionalContext, /confirmed remote mode/)
  assert.equal(readMark('s-answer', env).manualRemote, true)
  assert.equal(readMark('s-answer', env).awaitingManualRemote, false)

  runHook('manual-confirm.mjs', { session_id: 's-answer', prompt: '本机' }, env)
  assert.equal(readMark('s-answer', env).manualRemote, true, '已经确认后不被普通消息翻转')

  const f = join(sessionsDir(env), 's-answer.json')
  writeFileSync(f, JSON.stringify({ manualRemote: true, at: Date.now() - 48 * 60 * 60_000 }), 'utf8')
  runHook('manual-confirm.mjs', { session_id: 's-answer', prompt: '继续处理' }, env)
  assert.ok(Date.now() - readMark('s-answer', env).at < 10_000, '活跃会话每次用户发消息时续期')
})

test('会话 id 里带路径的一律拒绝，不做清洗', () => {
  const env = tempEnv()
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '', '.', 'a..b']) {
    assert.equal(writeMark(bad, { remote: true }, env), null, `${JSON.stringify(bad)} 不该被写进去`)
    assert.equal(readMark(bad, env), null)
  }
})

test('过期的标记会被清掉，目录不会越长越大', () => {
  const env = tempEnv()
  writeMark('fresh', { remote: true }, env)
  mkdirSync(sessionsDir(env), { recursive: true })
  writeFileSync(join(sessionsDir(env), 'old.json'), JSON.stringify({ at: Date.now() - 48 * 60 * 60_000 }), 'utf8')
  writeFileSync(join(sessionsDir(env), 'junk.json'), 'not json', 'utf8')

  assert.equal(pruneMarks(env), 2)
  assert.ok(existsSync(join(sessionsDir(env), 'fresh.json')))
})

test('hasOpenInteraction 只认 i-xxxx.json，别的文件不算', () => {
  const env = tempEnv()
  assert.equal(hasOpenInteraction(env), false)

  const dir = join(env.MP_STATE_DIR, 'interactions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'i-abc123.cloudflared.log'), '', 'utf8')
  assert.equal(hasOpenInteraction(env), false, '只剩日志不等于还有问题开着')

  writeFileSync(join(dir, 'i-abc123.json'), JSON.stringify({ stage: 'collecting' }), 'utf8')
  assert.equal(hasOpenInteraction(env), true)
})

test('答完的记录不算「问题还开着」——它比答案多活两个小时，不能把兜底静音那么久', () => {
  const env = tempEnv()
  const dir = join(env.MP_STATE_DIR, 'interactions')
  mkdirSync(dir, { recursive: true })

  const write = (body) => writeFileSync(join(dir, 'i-abc123.json'), JSON.stringify(body), 'utf8')

  write({ stage: 'collecting', expiresAt: Date.now() + 60_000 })
  assert.equal(hasOpenInteraction(env), true)

  write({ stage: 'submitted', response: { disposition: 'answered' }, expiresAt: Date.now() + 60_000 })
  assert.equal(hasOpenInteraction(env), false, '答过了就不是「正在问」')

  write({ stage: 'expired_link', expiresAt: Date.now() + 60_000 })
  assert.equal(hasOpenInteraction(env), false, '链接都过期了，用户面前没有页面')

  write({ stage: 'collecting', expiresAt: Date.now() - 1 })
  assert.equal(hasOpenInteraction(env), false, '记录过期了也一样')

  writeFileSync(join(dir, 'i-abc123.json'), '{ 半截', 'utf8')
  assert.equal(hasOpenInteraction(env), false, '读不出来就当没有——这个钩子的安全方向是闭嘴')
})

// ---- 第二层：问题工具的 PreToolUse ----

const bigChoice = {
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{
      header: '方案',
      question: '死表删还是留？',
      options: [
        { label: 'a DROP TABLE', description: '库面干净，但会删掉一条 active 契约的事实前提，而且是一次纯为清理的生产迁移' },
        { label: 'b 留着加注释', description: '零风险，代价是库里长期躺着一张会被误当成权限来源的表' },
        { label: 'c 留表清数据', description: '两头不靠：既留着误导性的结构，又让引用连文本出处都没了' },
      ],
    }],
  },
}

const smallChoice = {
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{ header: '继续', question: '要我接着改吗？', options: [{ label: '好' }, { label: '先别' }] }],
  },
}

test('选项多又都要解释的问题，在问出口之前就被拦下并给出替代命令', () => {
  const v = askDecide(bigChoice, { remote: true })
  assert.ok(v, '三个带长说明的选项正是聊天里最难读的那种')
  assert.match(v.deny, /mp interaction ask/)
  assert.match(v.deny, /mp interaction wait/)
  assert.match(v.deny, /mobile-preview skill/)
})

test('一句话的二选一不拦——否则每件小事都要开一次页面', () => {
  assert.equal(askDecide(smallChoice, { remote: true }), null)
})

test('本地会话一概不拦：那边终端里的选择界面本来就好用', () => {
  assert.equal(askDecide(bigChoice, { remote: false }), null)
})

test('别的工具、空问题、缺字段都不管', () => {
  assert.equal(askDecide({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { remote: true }), null)
  assert.equal(askDecide({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } }, { remote: true }), null)
  assert.equal(askDecide({ tool_name: 'AskUserQuestion' }, { remote: true }), null)
  assert.equal(askDecide({}, { remote: true }), null)
})

// Codex 把选项写成裸字符串、把题干放在 title 里，和 Claude Code 的
// question/options[{label,description}] 完全不同。这一条验的是「按结构判断而不
// 是按字段名」，所以样例要明确越过门槛，别让它去替阈值本身作证。
test('Codex 的 request_user_input 走同一条路，哪怕字段名不一样', () => {
  const codex = {
    tool_name: 'request_user_input',
    tool_input: {
      questions: [{
        title: '令牌有效期定多少',
        options: [
          '15 分钟：够小仓库，但大仓库里 agent 采集档案、跑 git rev-list 来不及，用户会反复看到「链接过期了」',
          '30 分钟：够用，而且一条已经写进 transcript 的凭据在外面多活的时间还可以接受',
          '2 小时：几乎不会过期，代价是那条凭据活得比整个任务还久，而泄漏正是这条契约的前提',
        ],
      }],
    },
  }
  const shape = askDecide(codex, { remote: true })
  assert.ok(shape, 'Codex 的形状不同，判断依据必须是结构而不是字段名')
  assert.equal(shape.shape.maxOptions, 3, '裸字符串的选项也要数得出来')
})

// 阈值本身是估的，P0 不调；但它落在哪一侧要能说清楚：三个各带半句解释的选项属
// 于「聊天里还读得动」，三个各带一整句的才不是。
test('三个只带半句解释的选项落在门槛下方，不拦', () => {
  const borderline = {
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: '有效期定多少？',
        options: [
          { label: '15 分钟', description: '大仓库来不及' },
          { label: '30 分钟', description: '够用且窗口可接受' },
          { label: '2 小时', description: '凭据活得太久' },
        ],
      }],
    },
  }
  assert.equal(askDecide(borderline, { remote: true }), null)
})

test('两个问题一起问且分量不轻的，也拦——它们之间的关系聊天里表达不出来', () => {
  const two = {
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          header: '丢弃',
          question: '丢弃 draft 后那一行是删掉还是留着？这决定同一个仓库以后还能不能重新接入。',
          options: [
            { label: '删除整行', description: '唯一索引随之释放，能重新接入；代价是那条系统 Issue 指向一行不存在的项目' },
            { label: '保留为 draft', description: '历史留着，但这一行永久占着唯一索引，同一仓库再也接不进来' },
          ],
        },
        {
          header: '多根仓库',
          question: '多根提交的仓库取哪个 root_commit？取错了唯一索引就拦不住重复接入。',
          options: [
            { label: '取排序后第一个', description: '确定性的，不依赖 git 输出顺序，并把全部根提交存下备查' },
            { label: '创建口直接拒绝', description: '最安全，但把合并过历史的仓库全挡在门外' },
          ],
        },
      ],
    },
  }
  assert.ok(askDecide(two, { remote: true }))
})

test('三个问题但每个只有两个短选项的，不拦', () => {
  const short = {
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        { header: '继续', question: '继续吗？', options: [{ label: '好' }, { label: '不' }] },
        { header: '测试', question: '跑测试吗？', options: [{ label: '跑' }, { label: '不跑' }] },
      ],
    },
  }
  assert.equal(askDecide(short, { remote: true }), null)
})

test('shapeOf 量的是「要读多少、有几种答法」，不碰问题讲的是什么', () => {
  const s = shapeOf(bigChoice.tool_input)
  assert.equal(s.count, 1)
  assert.equal(s.maxOptions, 3)
  assert.ok(s.heaviestOptions > 150)
  assert.ok(s.load > 100)
})

// 同一个问题写成中文比写成英文字符数少得多。按字符数一刀切，中文的问题永远够不
// 到门槛，这个功能在中文会话里就等于没装。
test('中文和英文里「一句话的解释」被算成差不多的分量', () => {
  const zh = shapeOf({ questions: [{ options: [{ description: '零风险，代价是库里长期躺着一张会被误当成权限来源的表' }] }] })
  const en = shapeOf({
    questions: [{
      options: [{ description: 'No risk at all; the cost is a table sitting in the database that the next person will mistake for the source of permissions' }],
    }],
  })
  assert.ok(zh.load > en.load / 2, `中文 ${zh.load} 对英文 ${en.load}：差距不该大到一个够门槛一个够不到`)
})

test('hook 进程真的会输出 deny，且带上理由', () => {
  const env = tempEnv()
  writeMark('s-remote', { remote: true }, env)
  const res = runHook('ask-question.mjs', { session_id: 's-remote', ...bigChoice }, env)

  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /mp interaction ask/)
})

test('没有会话标记时，大问题先请用户确认一次设备', () => {
  const env = tempEnv()
  const res = runHook('ask-question.mjs', { session_id: 's-unknown', ...bigChoice }, env)

  assert.equal(res.status, 0, res.stderr)
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason, /mp remote on/)
})

test('未确认设备时，大问题先问一次；确认本机后安静，确认远端后开交互页', () => {
  const env = tempEnv()
  writeMark('s-choice', { remote: false }, env)
  const input = { session_id: 's-choice', ...bigChoice }
  const unknown = runHook('ask-question.mjs', input, env)
  assert.equal(unknown.status, 0, unknown.stderr)
  assert.match(JSON.parse(unknown.stdout).hookSpecificOutput.permissionDecisionReason, /mp remote on/)
  assert.equal(readMark('s-choice', env).awaitingManualRemote, true)

  writeMark('s-choice', { manualRemote: false }, env)
  assert.equal(runHook('ask-question.mjs', input, env).stdout.trim(), '')
  writeMark('s-choice', { manualRemote: true }, env)
  assert.match(JSON.parse(runHook('ask-question.mjs', input, env).stdout).hookSpecificOutput.permissionDecisionReason, /mp interaction ask/)
})

// ---- 第三层：Stop 兜底 ----

const LONG = `${'这是一段关于数据库迁移取舍的说明。'.repeat(120)}
你倾向哪一个？
1. 删除整行
2. 保留为 draft
3. 转成停用态`

test('长篇写完又以问题结尾的回合，会被拦下要求改成页面', () => {
  const v = stopDecide({ last_assistant_message: LONG }, { remote: true })
  assert.ok(v)
  assert.match(v.block, /mp interaction ask/)
  assert.match(v.block, /If this really is not a decision/, '给一条退出的路，否则模型会被卡住')
})

test('短消息、不问问题的长消息都不拦', () => {
  assert.equal(looksLikeAnUnansweredDecision('改完了，测试都过了。'), false)
  assert.equal(looksLikeAnUnansweredDecision(`${'说明。'.repeat(600)}已经按这个做了。`), false)
})

test('结尾是列表而不是问号的，也算在问', () => {
  const enumerated = `${'背景说明。'.repeat(320)}
- 维持现状
- 原地改成新契约`
  assert.equal(looksLikeAnUnansweredDecision(enumerated), true)
})

test('页面已经开着时不拦——那条消息是在介绍页面，不是在代替页面', () => {
  assert.equal(stopDecide({ last_assistant_message: LONG }, { remote: true, pageOpen: true }), null)
})

test('本地会话不拦，已经拦过两次也不再拦', () => {
  assert.equal(stopDecide({ last_assistant_message: LONG }, { remote: false }), null)
  assert.equal(stopDecide({ last_assistant_message: LONG }, { remote: true, blocks: 2 }), null)
})

test('未确认设备时，长篇决策只要求一次人工确认', () => {
  const env = tempEnv()
  writeMark('s-confirm', { remote: false, blocks: 0 }, env)
  const first = runHook('stop.mjs', { session_id: 's-confirm', last_assistant_message: LONG }, env)
  assert.equal(first.status, 0, first.stderr)
  assert.match(JSON.parse(first.stdout).reason, /mp remote on/)
  assert.equal(readMark('s-confirm', env).blocks, 0, '确认问题不应耗掉决策页兜底次数')
  assert.equal(readMark('s-confirm', env).awaitingManualRemote, true)

  writeMark('s-confirm', { manualRemote: false }, env)
  assert.equal(runHook('stop.mjs', { session_id: 's-confirm', last_assistant_message: LONG }, env).stdout.trim(), '')
})

test('stop_hook_active 时立刻让路，绝不和自己较劲', () => {
  assert.equal(stopDecide({ last_assistant_message: LONG, stop_hook_active: true }, { remote: true }), null)
})

test('last_assistant_message 为空或缺失时什么都不做', () => {
  assert.equal(stopDecide({ last_assistant_message: null }, { remote: true }), null)
  assert.equal(stopDecide({}, { remote: true }), null)
})

test('hook 进程输出两个宿主都认的 block，并把次数记进会话', () => {
  const env = tempEnv()
  writeMark('s-stop', { remote: true, blocks: 0 }, env)

  const first = runHook('stop.mjs', { session_id: 's-stop', last_assistant_message: LONG }, env)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(JSON.parse(first.stdout).decision, 'block')
  assert.equal(readMark('s-stop', env).blocks, 1)

  runHook('stop.mjs', { session_id: 's-stop', last_assistant_message: LONG }, env)
  assert.equal(readMark('s-stop', env).blocks, 2)

  const third = runHook('stop.mjs', { session_id: 's-stop', last_assistant_message: LONG }, env)
  assert.equal(third.stdout.trim(), '', '拦过两次就收手，不跟模型没完没了')
})

// ---- Claude 桌面 App 自带的远程 ----
//
// 2026-09-24 实测：手机从 Claude App 远程发消息，会话自己什么都看不出来；只有桌面
// App 给这个会话记的元数据里 steeredByRemoteClient 会按消息翻转，且晚 6–25 秒写。

function desktopEnv(meta, id = 'local_ac4a7092-4cc1-44af-8397-09e935769fea') {
  const app = mkdtempSync(join(tmpdir(), 'mp-desktop-'))
  const dir = join(app, 'claude-code-sessions', 'acct-1', 'org-1')
  mkdirSync(dir, { recursive: true })
  if (meta !== undefined) writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta), 'utf8')
  return { ...tempEnv(), MP_CLAUDE_DESKTOP_DIR: app, CLAUDE_CODE_HOST_SESSION_ID: id }
}

test('桌面会话：最近一条是手机发的就算远程，电脑发的就不算', () => {
  assert.equal(steeredFromPhone(desktopEnv({ steeredByRemoteClient: true })), true)
  assert.equal(steeredFromPhone(desktopEnv({ steeredByRemoteClient: false })), false)
  assert.equal(steeredFromPhone(desktopEnv({})), false, '没有这个字段的老会话当本地')
  assert.deepEqual(remoteStatus(null, desktopEnv({ steeredByRemoteClient: false })), {
    remote: false, confirmed: true,
  }, '明确的本机来源不该再要求手动确认')
  assert.deepEqual(remoteStatus({ manualRemote: true }, desktopEnv({ steeredByRemoteClient: false })), {
    remote: false, confirmed: true,
  }, 'Claude 从手机切回本机时不能被旧的手动标记锁在远端')
})

test('找不到元数据、会话 id 不像样、文件坏了，都当本地，不能崩', () => {
  assert.equal(steeredFromPhone(desktopEnv(undefined)), false)
  assert.equal(steeredFromPhone({ ...desktopEnv({ steeredByRemoteClient: true }), CLAUDE_CODE_HOST_SESSION_ID: '../x' }), false)
  assert.equal(steeredFromPhone({ ...desktopEnv({ steeredByRemoteClient: true }), CLAUDE_CODE_HOST_SESSION_ID: '' }), false)
  const env = desktopEnv({ steeredByRemoteClient: true })
  writeFileSync(desktopSessionFile(env), '{not json', 'utf8')
  assert.equal(steeredFromPhone(env), false)
  assert.equal(steeredFromPhone({ PATH: process.env.PATH }), false)
})

test('Happy 标记和桌面信号任一成立就是远程', () => {
  const local = desktopEnv({ steeredByRemoteClient: false })
  assert.equal(isRemoteNow({ remote: true }, local), true)
  assert.equal(isRemoteNow(null, desktopEnv({ steeredByRemoteClient: true })), true)
  assert.equal(isRemoteNow({ remote: false }, local), false)
})

test('桌面会话从手机发来时，Stop 和提问两道都按远程处理——哪怕 SessionStart 记的是本地', () => {
  const env = desktopEnv({ steeredByRemoteClient: true })
  writeMark('s-desk', { remote: false, blocks: 0 }, env)

  const stop = runHook('stop.mjs', { session_id: 's-desk', last_assistant_message: LONG }, env)
  assert.equal(stop.status, 0, stop.stderr)
  assert.equal(JSON.parse(stop.stdout).decision, 'block')

  const ask = runHook('ask-question.mjs', { session_id: 's-desk', ...bigChoice }, env)
  assert.equal(ask.status, 0, ask.stderr)
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, 'deny')
})

test('同一个桌面会话回到电脑上发，两道都不再管', () => {
  const env = desktopEnv({ steeredByRemoteClient: false })
  writeMark('s-desk2', { remote: false, blocks: 0 }, env)
  assert.equal(runHook('stop.mjs', { session_id: 's-desk2', last_assistant_message: LONG }, env).stdout.trim(), '')
  assert.equal(runHook('ask-question.mjs', { session_id: 's-desk2', ...bigChoice }, env).stdout.trim(), '')
})

test('人在手机上，回复里递的是 localhost 地址——拦下，让它先过 mp', () => {
  const v = stopDecide({ last_assistant_message: '改好了，打开 http://localhost:5173/settings 看看。' }, { remote: true })
  assert.ok(v)
  assert.match(v.block, /mp start --port/)
  assert.match(v.block, /carry on/, '给一条退出的路：地址可能只是配置里的一个值')
  assert.ok(stopDecide({ last_assistant_message: '在 http://127.0.0.1:8022/ 上' }, { remote: true }))
})

test('localhost 这条：人在电脑前、同时给了隧道链接、页面开着但地址还是本地的', () => {
  const env = tempEnv()
  mkdirSync(join(env.MP_STATE_DIR, 'previews'), { recursive: true })
  writeFileSync(join(env.MP_STATE_DIR, 'previews', '6553.json'), JSON.stringify({
    targetPort: 6553, tunnelUrl: 'https://abc-def.trycloudflare.com', sessionToken: 'x',
    expiresAt: Date.now() + 60_000,
  }))
  const msg = '打开 http://localhost:5173 看看'
  assert.ok(stopDecide({ last_assistant_message: msg }, { remote: false }), '设备未知或本机也要附远程可用链接')
  assert.equal(stopDecide({
    last_assistant_message: `手机上点这个：\nhttps://abc-def.trycloudflare.com/?__mp_token=x\n本机是 http://127.0.0.1:6553/`,
  }, { remote: true, env }), null)
  assert.ok(stopDecide({ last_assistant_message: msg }, { remote: true, pageOpen: true }), '开着的页面不让本地地址变得能打开')
  assert.equal(handsOverLocalAddress('监听在 localhost 上'), false, '只认可点的地址，不认单词')
})

test('无令牌、错令牌、错页面或过期的隧道都不能让 localhost 交付过关', () => {
  const env = tempEnv()
  const dir = join(env.MP_STATE_DIR, 'previews')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '5173.json'), JSON.stringify({
    targetPort: 5173, tunnelUrl: 'https://right.trycloudflare.com', sessionToken: 'correct',
    expiresAt: Date.now() + 60_000,
  }))
  const local = 'http://localhost:5173/'
  for (const remote of [
    'https://right.trycloudflare.com/',
    'https://right.trycloudflare.com/?__mp_token=wrong',
    'https://other.trycloudflare.com/?__mp_token=correct',
  ]) {
    assert.equal(handsOverLocalAddress(`${local} ${remote}`, env), true)
  }
  assert.equal(handsOverLocalAddress(`${local} https://right.trycloudflare.com/?__mp_token=correct`, env), false)
  assert.equal(handsOverLocalAddress(`${local}settings?view=all https://right.trycloudflare.com/?__mp_token=correct`, env), true)
  assert.equal(handsOverLocalAddress(`${local}settings?view=all https://right.trycloudflare.com/settings?view=all&__mp_token=correct`, env), false)
  assert.equal(handsOverLocalAddress(`${local} http://localhost:5174/ https://right.trycloudflare.com/?__mp_token=correct`, env), true)
  writeFileSync(join(dir, '5173.json'), JSON.stringify({
    targetPort: 5173, tunnelUrl: 'https://right.trycloudflare.com', sessionToken: 'correct',
    expiresAt: Date.now() - 1,
  }))
  assert.equal(handsOverLocalAddress(`${local} https://right.trycloudflare.com/?__mp_token=correct`, env), true)
})

test('interaction 页面只认同一个表单端口与 token 的远程链接', () => {
  const env = tempEnv()
  const dir = join(env.MP_STATE_DIR, 'interactions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'i-abc123.json'), JSON.stringify({
    formPort: 8123, tunnelUrl: 'https://decision.trycloudflare.com', sessionToken: 'answer-token',
    expiresAt: Date.now() + 60_000,
  }))
  assert.equal(handsOverLocalAddress('http://127.0.0.1:8123/ https://decision.trycloudflare.com/?__mp_token=answer-token', env), false)
  assert.equal(handsOverLocalAddress('http://127.0.0.1:8124/ https://decision.trycloudflare.com/?__mp_token=answer-token', env), true)
})

test('可打开的 localhost 链接不消耗长篇决策次数；本机会话的第三次预览也会被拦', () => {
  const env = tempEnv()
  writeMark('s-preview', { remote: false, manualRemote: false, blocks: 0 }, env)
  for (let i = 0; i < 3; i += 1) {
    const res = runHook('stop.mjs', { session_id: 's-preview', last_assistant_message: `打开 http://localhost:${5100 + i}/` }, env)
    assert.equal(res.status, 0, res.stderr)
    assert.match(JSON.parse(res.stdout).reason, /mp start --port/)
  }
  assert.equal(readMark('s-preview', env).blocks, 0)
})

// ---- 读取负载 ----

test('stdin 不关闭时不会把 hook 挂死，而是当作没有负载', async () => {
  const { PassThrough } = await import('node:stream')
  const stuck = new PassThrough()
  stuck.write('{"session_id":"x"')

  const t0 = Date.now()
  const payload = await readPayload(stuck, 60)
  assert.equal(payload, null)
  assert.ok(Date.now() - t0 < 2_000, '超时就该放手，而不是等到 hooks.json 的 timeout 把它杀掉')
})

test('正常的负载照常解析', async () => {
  const { Readable } = await import('node:stream')
  const payload = await readPayload(Readable.from([JSON.stringify({ session_id: 'ok' })]), 1_000)
  assert.equal(payload.session_id, 'ok')
})

// ---- 注册 ----

test('hooks.json 把两个新触发挂在对的事件上，指向真实存在的脚本', () => {
  const hooks = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'))

  const ask = hooks.hooks.PreToolUse.find((e) => /ask-question/.test(e.hooks[0].command))
  assert.ok(ask, '问题工具那一层必须挂在 PreToolUse 上')
  assert.match(ask.matcher, /AskUserQuestion/)
  assert.match(ask.matcher, /request_user_input/, 'Codex 的工具名不一样，漏了就等于只装了一半')
  assert.match(ask.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/)

  const stop = hooks.hooks.Stop[0]
  assert.equal(stop.matcher, undefined, 'Stop 没有 matcher 可言，每个回合结束都要看一眼')
  assert.match(stop.hooks[0].command, /stop\.mjs/)
  assert.match(stop.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/)

  const confirm = hooks.hooks.UserPromptSubmit[0]
  assert.match(confirm.hooks[0].command, /manual-confirm\.mjs/)

  // 原来那条 Bash|PowerShell 的 deny 不能被挤掉。
  const secret = hooks.hooks.PreToolUse.find((e) => /pre-tool-use/.test(e.hooks[0].command))
  assert.equal(secret.matcher, 'Bash|PowerShell')

  for (const file of ['ask-question.mjs', 'stop.mjs', 'manual-confirm.mjs', 'session-mark.mjs', 'hook-io.mjs']) {
    assert.ok(existsSync(join(HOOKS, file)), `hooks.json 指向的 ${file} 必须存在`)
  }
})

test('注入的文字里要有「页面得画出来」这条——它决定页面值不值得开', () => {
  assert.match(REMOTE_CONTEXT, /draw/i)
  assert.match(REMOTE_CONTEXT, /SVG/i, '得说清用什么画，否则模型会去找图片素材')
  assert.match(
    REMOTE_CONTEXT,
    /wall of text/i,
    '只读注入的模型不会去加载 skill；这条要是只写在 skill 里，等于没写',
  )
})

test('中文的长篇和英文的长篇被同等对待——不然这道兜底对中文用户等于没装', () => {
  // 同一段话的两种语言。字符数差三倍，要读的东西一样多。
  const zh = `${'把这几条排一下优先级，每条我都写清楚了代价。'.repeat(40)}\n\n你想先做哪个？`
  const en = `${'Please rank these items, I have written out the cost of each one. '.repeat(24)}\n\nWhich would you like first?`

  assert.ok(zh.length < 1_000, '这段中文只有几百个字符，按字符数根本够不着门槛')
  assert.equal(looksLikeAnUnansweredDecision(zh), true, '中文的长篇也要拦')
  assert.equal(looksLikeAnUnansweredDecision(en), true, '英文的长篇照旧拦')

  // 短的还是不拦，两种语言都一样。
  assert.equal(looksLikeAnUnansweredDecision('两个方案你选哪个？'), false)
  assert.equal(looksLikeAnUnansweredDecision('Which of the two do you prefer?'), false)
})
