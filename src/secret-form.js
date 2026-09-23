import { createServer } from 'node:http'
import { basename, relative } from 'node:path'
import { createAccessGate, json, notFound, readBody } from './http-util.js'
import { BROWSER_ENCRYPT_JS } from './secret-crypto.js'
import {
  DEFAULT_EXPIRY_DAYS, DEFAULT_LEVEL, EXPIRY_DAYS, LEVELS, PASSPHRASE_MIN_LENGTH, strictestLevel,
} from './secret-vault.js'

// The page a phone opens to hand values to the daemon. It borrows the
// preview proxy's authentication wholesale — token exchange, grace window,
// 404 on every failure, per-IP limiter — and adds exactly one thing the proxy
// does not have: a body. Bare node:http, no framework, fail closed.
//
// Three shapes of one page:
// - fill:    type the values in; fields saved earlier offer "用已保存的".
// - confirm: every field is saved at a level that wants the phone once per
//            session — one tap (or the passphrase) and done; "重新填写" turns
//            it back into fill.
// - approve: the values are already held; only new uses or render targets
//            are on the page.
// Whether to save, at which level, for how long: only ever chosen here.
//
// The page is one response with nothing to fetch — the CSP is default-src
// 'none' and the tunnel from China runs at tens of KB/s — so the styles, the
// few line icons and the script are all inline, and kept small.

const COOKIE = 'mp_secret'
// Rides the same encrypted channel as the fields, under a name no field can
// have (FIELD_NAME_RE refuses the `__mp_` prefix).
export const PASSPHRASE_FIELD = '__mp_passphrase'

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

// JSON inside a <script> must not be able to close the tag.
function jsonForScript(v) {
  return JSON.stringify(v).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`
const ICON = {
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2.5"></rect><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"></path>'),
  term: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"></rect><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"></path>'),
  file: svg('<path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9.5z"></path><path d="M13.5 3.5v6h6"></path>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"></path><circle cx="12" cy="12" r="3"></circle>'),
  shield: svg('<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"></path><path d="m9 12 2.2 2.2L15.5 10"></path>'),
  folder: svg('<path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.6l2 2.5H18a2.5 2.5 0 0 1 2.5 2.5V17a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17z"></path>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"></path>'),
}

const CSS = `
:root{color-scheme:light dark;--bg:#f3f3f5;--card:#fff;--ink:#17181c;--muted:#6b6d76;--line:#e4e4e9;--edge:#c9cbd3;--field:#f5f5f8;--accent:#2b5fd9;--on-accent:#fff;--soft:#e9effc;--danger:#c8371d;--danger-soft:#fdeeeb;--warn:#9a5a06;--warn-soft:#fbf0dc;--ok:#1f8a4c;--bar:rgba(243,243,245,.88)}
@media (prefers-color-scheme:dark){:root{--bg:#0e0f12;--card:#17181c;--ink:#ececf1;--muted:#9a9ca6;--line:#2a2c33;--edge:#454852;--field:#1f2126;--accent:#7aa2ff;--on-accent:#0b1020;--soft:#1b2640;--danger:#ff8a70;--danger-soft:#3a1d17;--warn:#f0b35a;--warn-soft:#33260f;--ok:#63d494;--bar:rgba(14,15,18,.88)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:480px;margin:0 auto;padding:28px 16px 0}
code,.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}
button{font:inherit;color:inherit;-webkit-tap-highlight-color:transparent}
.hero{padding:0 4px 18px}
.eyebrow{display:flex;align-items:center;gap:6px;color:var(--accent);font-size:13px;font-weight:600}
.eyebrow svg{width:16px;height:16px}
h1{margin:6px 0 12px;font-size:24px;line-height:1.35;font-weight:700;text-wrap:pretty}
.meta{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--muted);font-size:13px;max-width:100%}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip svg{width:15px;height:15px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin:0 0 12px}
.card-title{margin:0;font-size:15px;font-weight:650}
.card-sub{margin:2px 0 12px;color:var(--muted);font-size:13px;line-height:1.55}
.fields{margin-top:6px}
.field{padding:14px 0}
.field+.field{border-top:1px solid var(--line)}
.field:first-child{padding-top:6px}
.field:last-child{padding-bottom:2px}
.label{display:block;margin:0 0 8px;font-size:13px;font-weight:600;overflow-wrap:anywhere}
.box{position:relative;display:flex;align-items:center}
.box input,.box textarea{width:100%;height:50px;padding:0 48px 0 14px;font:inherit;font-size:16px;color:var(--ink);background:var(--card);border:1.5px solid var(--edge);border-radius:12px;outline:none;box-shadow:inset 0 1px 2px rgba(0,0,0,.04);transition:border-color .15s,box-shadow .15s;-webkit-appearance:none}
.box input::placeholder,.box textarea::placeholder{color:var(--muted);opacity:.75}
.box.plain input{padding-right:14px}
.box textarea{height:auto;min-height:104px;padding:12px 14px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;resize:vertical}
.box input:focus,.box textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--soft)}
.bad .box input,.bad .box textarea{border-color:var(--danger);background:var(--danger-soft)}
input::-ms-reveal{display:none}
.eye{position:absolute;right:2px;width:44px;height:44px;display:grid;place-items:center;border:0;background:none;color:var(--muted);border-radius:10px}
.eye[aria-pressed="true"]{color:var(--accent)}
.err{margin:6px 0 0;color:var(--danger);font-size:13px}
.err:empty{display:none}
.saved-row{display:flex;align-items:center;gap:12px}
.tile{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;flex:none;background:var(--soft);color:var(--accent)}
.tile.dim{background:var(--card);color:var(--muted);border:1px solid var(--line)}
.grow{flex:1;min-width:0}
.saved-row .label{margin:0}
.saved-meta{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;color:var(--muted);font-size:13px}
.badge{font-size:11px;font-weight:600;line-height:18px;padding:0 7px;border-radius:999px;background:var(--soft);color:var(--accent);flex:none}
.badge.warn{background:var(--warn-soft);color:var(--warn)}
.keep-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;padding:8px 8px 8px 14px;border-radius:12px;background:var(--field);font-size:14px;cursor:pointer}
.saved .box{margin-top:12px}
.sw{position:relative;flex:none;width:50px;height:30px}
.sw input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1}
.track{position:absolute;inset:0;border-radius:999px;background:var(--edge);transition:background .2s}
.track:after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s}
.sw input:checked+.track{background:var(--accent)}
.sw input:checked+.track:after{transform:translateX(20px)}
.sw input:focus-visible+.track{outline:2px solid var(--accent);outline-offset:2px}
.list{display:grid;gap:8px}
.item{display:flex;align-items:center;gap:12px;min-height:64px;padding:12px;border-radius:14px;background:var(--field);cursor:pointer}
.item-main{flex:1;min-width:0;display:grid;gap:1px}
.kicker{font-size:12px;color:var(--muted)}
.item-title{font-size:14px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}
.item-note{font-size:12px;color:var(--warn);overflow-wrap:anywhere}
.head{display:flex;align-items:center;gap:12px;cursor:pointer}
.opts{display:grid;gap:8px;margin-top:16px}
.opt{position:relative;display:block;cursor:pointer}
.opt input{position:absolute;opacity:0;pointer-events:none}
.opt-box{display:flex;align-items:flex-start;gap:12px;padding:13px 14px;border:1.5px solid var(--line);border-radius:14px;transition:border-color .15s,background .15s}
.dot{flex:none;width:20px;height:20px;margin-top:2px;border-radius:50%;border:2px solid var(--line);display:grid;place-items:center}
.dot:after{content:"";width:10px;height:10px;border-radius:50%;background:var(--accent);transform:scale(0);transition:transform .15s}
.opt input:checked+.opt-box{border-color:var(--accent);background:var(--soft)}
.opt input:checked+.opt-box .dot{border-color:var(--accent)}
.opt input:checked+.opt-box .dot:after{transform:scale(1)}
.opt input:focus-visible+.opt-box{outline:2px solid var(--accent);outline-offset:2px}
.opt-title{display:block;font-size:15px;font-weight:650}
.opt-sub{display:block;font-size:13px;color:var(--muted);line-height:1.5}
.sub-label{margin:18px 0 8px;font-size:13px;font-weight:600;color:var(--muted)}
.seg{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px;background:var(--field);border-radius:12px}
.seg label{position:relative;display:block;cursor:pointer}
.seg input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.seg span{display:grid;place-items:center;height:40px;border-radius:9px;font-size:14px;color:var(--muted)}
.seg input:checked+span{background:var(--card);color:var(--ink);font-weight:650;box-shadow:0 1px 3px rgba(0,0,0,.14)}
.seg input:focus-visible+span{outline:2px solid var(--accent)}
.hint{margin:12px 0 0;font-size:12.5px;color:var(--muted)}
.names{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;padding:0;list-style:none}
.names li{padding:4px 10px;border-radius:8px;background:var(--field);font-size:13px}
.trust{display:flex;gap:8px;align-items:flex-start;margin:4px 0 0;padding:0 6px 14px;color:var(--muted);font-size:12.5px;line-height:1.6}
.trust svg{width:16px;height:16px;margin-top:3px}
.bar{position:sticky;bottom:0;z-index:5;margin:0 -16px;padding:10px 16px calc(12px + env(safe-area-inset-bottom));background:var(--bar);-webkit-backdrop-filter:saturate(1.4) blur(14px);backdrop-filter:saturate(1.4) blur(14px);border-top:1px solid var(--line)}
.status{margin:0 0 8px;text-align:center;font-size:13px;color:var(--danger)}
.status:empty{display:none}
.primary{width:100%;height:52px;border:0;border-radius:14px;background:var(--accent);color:var(--on-accent);font-size:16px;font-weight:650;display:flex;align-items:center;justify-content:center;gap:8px}
.primary:active{transform:scale(.99)}
.primary:disabled{opacity:.65}
.spin{display:none;width:18px;height:18px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .8s linear infinite}
.busy .spin{display:block}
@keyframes spin{to{transform:rotate(360deg)}}
.ghost{display:block;width:100%;height:44px;margin-top:4px;border:0;background:none;color:var(--accent);font-size:15px;font-weight:600}
.done-box{min-height:88vh;display:grid;place-content:center;justify-items:center;gap:8px;padding:24px;text-align:center}
.done-icon{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;background:var(--soft);color:var(--ok)}
.done-icon svg{width:32px;height:32px;stroke-width:2.4}
.done-box h1{margin:10px 0 0}
.done-box p{margin:0;max-width:300px;color:var(--muted);text-wrap:pretty}
[hidden]{display:none!important}
`

function ago(t, now = Date.now()) {
  const h = Math.floor((now - t) / 3_600_000)
  if (h < 1) return '刚保存'
  if (h < 24) return `${h} 小时前保存`
  return `${Math.floor(h / 24)} 天前保存`
}

// Every input carries a placeholder: an empty box on a white card read as
// decoration, not as somewhere to type (the user, 2026-09-21).
function inputHtml({ name, kind }, hidden, { replacing = false } = {}) {
  const id = `f-${name}`
  const h = hidden ? ' hidden' : ''
  const hint = replacing ? '输入新的值' : kind === 'multiline' ? '粘贴到这里' : kind === 'text' ? '输入' : '粘贴或输入'
  const common = `id="${esc(id)}" data-field="${esc(name)}" data-kind="${esc(kind)}" placeholder="${hint}" `
    + 'autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"'
  if (kind === 'multiline') {
    return `<div class="box input"${h}><textarea ${common}></textarea></div>`
  }
  if (kind === 'text') {
    return `<div class="box plain input"${h}><input type="text" ${common}></div>`
  }
  return `<div class="box input"${h}><input type="password" ${common}>`
    + `<button type="button" class="eye" data-toggle="${esc(id)}" aria-label="显示" aria-pressed="false">${ICON.eye}</button></div>`
}

function fieldHtml(f, saved, { mode, refill, now }) {
  const s = saved[f.name]
  const err = `<p class="err" data-err="${esc(f.name)}"></p>`
  if (!s) {
    return `<div class="field"><label class="label mono" for="f-${esc(f.name)}">${esc(f.name)}</label>`
      + `${inputHtml(f, false)}${err}</div>`
  }
  const keep = !refill
  const badges = (s.status === 'expired' ? '<span class="badge warn">已过期</span>' : '')
    + (s.level === 'passphrase' ? '<span class="badge">主密码</span>' : '')
  // Its own full-width row under the name, not squeezed beside it: beside it,
  // a long name like OSS_ACCESS_KEY_SECRET broke in the middle of a word.
  const keepText = s.status === 'expired' ? '沿用原值并续期' : '用已保存的值'
  const keepSwitch = `<label class="keep-row${mode === 'confirm' ? ' refill-only" hidden' : '"'}><span>${keepText}</span>`
    + `<span class="sw"><input type="checkbox" role="switch" data-keep="${esc(f.name)}" data-level="${esc(s.level)}"${keep ? ' checked' : ''}>`
    + '<span class="track"></span></span></label>'
  return '<div class="field saved"><div class="saved-row">'
    + `<span class="tile">${ICON.lock}</span>`
    + `<div class="grow"><div class="label mono">${esc(f.name)}</div>`
    + `<div class="saved-meta"><span>${s.length} 位 · ${esc(s.sha256_8)}</span><span>${ago(s.savedAt, now)}</span>${badges}</div></div>`
    + `</div>${keepSwitch}${inputHtml(f, keep, { replacing: true })}${err}</div>`
}

const LEVEL_OPTIONS = [
  ['auto', '直接用', '批准过的命令直接跑，以后不再问你'],
  ['confirm', '点一下', '每次用之前，在手机上点一下确认'],
  ['passphrase', '主密码', '每次用之前输一次主密码；AI 想偷得先猜中它'],
]

// The expiry the user chose last time, as the default for saving again. Left
// at the 90-day default, keeping a 7-day key and pressing submit re-sealed it
// for 90 days — and a "never" key for 90 too — without anyone choosing that.
// Several fields: the shortest wins, the same way the strictest level does.
export function presetDays(metas) {
  const chosen = metas.map((m) => (m.expiresAt && m.savedAt
    ? Math.max(1, Math.round((m.expiresAt - m.savedAt) / 86_400_000))
    : 0))
  const finite = chosen.filter((d) => d > 0)
  if (!finite.length) return 0
  const want = Math.min(...finite)
  return EXPIRY_DAYS.filter((d) => d > 0)
    .reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a))
}

function saveHtml(save, { preset, confirm }) {
  const hide = confirm ? ' refill-only" hidden' : '"'
  if (!save.available) {
    return `<section class="card${hide}><p class="card-sub" style="margin:0">这台电脑没有可用的系统钥匙串，不能保存；这次的值只留在内存里。</p></section>`
  }
  const level = preset?.level || DEFAULT_LEVEL
  const opts = LEVEL_OPTIONS.map(([v, t, d]) => `<label class="opt"><input type="radio" name="level" value="${v}"${v === level ? ' checked' : ''}>`
    + `<span class="opt-box"><span class="dot"></span><span><span class="opt-title">${t}</span><span class="opt-sub">${d}</span></span></span></label>`).join('')
  const dayPick = preset?.days ?? DEFAULT_EXPIRY_DAYS
  const days = EXPIRY_DAYS.map((d) => `<label><input type="radio" name="days" value="${d}"${d === dayPick ? ' checked' : ''}>`
    + `<span>${d ? `${d} 天` : '不过期'}</span></label>`).join('')
  return `<section class="card${hide}>`
    + '<label class="head"><span class="grow"><span class="card-title" style="display:block">在这台电脑上记住</span>'
    + '<span class="card-sub" style="display:block;margin:2px 0 0">加密保存，下次不用再翻出来填</span></span>'
    + `<span class="sw"><input type="checkbox" role="switch" id="save"${preset ? ' checked' : ''}><span class="track"></span></span></label>`
    + `<div id="save-opts"${preset ? '' : ' hidden'}>`
    + `<div class="opts" role="radiogroup" aria-label="下次怎么用">${opts}</div>`
    + `<div class="sub-label">有效期</div><div class="seg" role="radiogroup" aria-label="有效期">${days}</div>`
    + '<p class="hint">生产环境、能花钱的钥匙，建议选更严的档。</p></div></section>'
}

function passphraseHtml(save) {
  if (!save.available) return ''
  const set = save.passphraseSet
  return '<section class="card" id="pp" hidden>'
    + `<label class="card-title" for="pp1" style="display:block">${set ? '输入主密码' : '设置主密码'}</label>`
    + `<p class="card-sub">${set ? '就是你当初设的那个。' : `至少 ${PASSPHRASE_MIN_LENGTH} 位，数字也行；位数越多越难被猜出。`}</p>`
    + `<div class="field" style="padding:0"><div class="box"><input type="password" id="pp1" placeholder="${set ? '输入主密码' : `至少 ${PASSPHRASE_MIN_LENGTH} 位`}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">`
    + `<button type="button" class="eye" data-toggle="pp1" aria-label="显示" aria-pressed="false">${ICON.eye}</button></div>`
    + (set ? '' : '<div class="box" style="margin-top:8px"><input type="password" id="pp2" placeholder="再输一遍" autocomplete="off"></div>')
    + '<p class="err" data-err="__pp"></p></div></section>'
}

function sw(attr) {
  return `<span class="sw"><input type="checkbox" role="switch" ${attr} checked><span class="track"></span></span>`
}

function useHtml(use, i, isNew) {
  return `<label class="item"><span class="tile dim">${ICON.term}</span>`
    + '<span class="item-main"><span class="kicker">运行命令</span>'
    + `<code class="item-title">${esc(use)}</code></span>`
    + `${isNew ? '<span class="badge">新</span>' : ''}${sw(`data-use="${i}"`)}</label>`
}

function fileHtml(f, i, projectRoot) {
  const shown = !f.outside && projectRoot ? relative(projectRoot, f.out) || f.out : f.out
  return `<label class="item"><span class="tile dim">${ICON.file}</span>`
    + `<span class="item-main"><span class="kicker">写入配置文件 · ${f.keep ? '一直保留' : '用完即删'}</span>`
    + `<code class="item-title">${esc(shown)}</code>`
    + `${f.outside ? '<span class="item-note">在项目目录之外</span>' : ''}</span>`
    + `${f.isNew ? '<span class="badge">新</span>' : ''}${sw(`data-file="${i}"`)}</label>`
}

// The message line is `statusEl`, never `status`: at the top level of a page
// that name is window.status, a legacy string property, and every
// `.textContent =` on it vanished without an error. Until 2026-09-21 the form
// showed no message at all — not "请输入主密码", not a server's 400 — which
// only driving it in a real mobile browser turned up.
const PAGE_JS = `
function $(s) { return document.querySelector(s) }
function all(s) { return Array.prototype.slice.call(document.querySelectorAll(s)) }
var form = $('#form'), btn = $('#submit'), statusEl = $('#status'), saveBox = $('#save')
var btnLabel = btn.querySelector('.btn-label'), idle = btnLabel.textContent
all('[data-toggle]').forEach(function (b) {
  b.addEventListener('click', function () {
    var i = document.getElementById(b.getAttribute('data-toggle'))
    var show = i.type === 'password'
    i.type = show ? 'text' : 'password'
    b.setAttribute('aria-pressed', show ? 'true' : 'false')
    b.setAttribute('aria-label', show ? '隐藏' : '显示')
  })
})
function saveOn() { return !!saveBox && saveBox.checked && !saveBox.closest('[hidden]') }
function pick(name, dflt) { var r = document.querySelector('input[name=' + name + ']:checked'); return r ? r.value : dflt }
function keptNames() { return all('[data-keep]').filter(function (el) { return el.checked }).map(function (el) { return el.getAttribute('data-keep') }) }
function needPassphrase() {
  var kept = all('[data-keep]').some(function (el) { return el.checked && el.getAttribute('data-level') === 'passphrase' })
  return kept || (saveOn() && pick('level', 'auto') === 'passphrase')
}
function sync() {
  all('[data-keep]').forEach(function (el) {
    var box = el.closest('.field').querySelector('.input')
    if (box) box.hidden = el.checked
  })
  var opts = $('#save-opts')
  if (opts) opts.hidden = !saveOn()
  var pp = $('#pp')
  if (pp) pp.hidden = !needPassphrase()
}
function say(msg) { statusEl.textContent = msg || '' }
function setErr(key, msg) {
  var el = document.querySelector('[data-err="' + key + '"]')
  if (!el) return null
  el.textContent = msg
  var box = el.closest('.field')
  if (box) box.classList.add('bad')
  return box
}
function clearErr(box) {
  box.classList.remove('bad')
  var e = box.querySelector('.err')
  if (e) e.textContent = ''
}
function busy(on, text) {
  btn.disabled = on
  btn.classList.toggle('busy', on)
  btnLabel.textContent = text || idle
}
document.addEventListener('change', sync)
document.addEventListener('input', function (e) {
  var f = e.target.closest && e.target.closest('.field')
  if (f) clearErr(f)
  if (!document.querySelector('.bad')) say('')
})
sync()
var refill = $('#refill')
if (refill) refill.addEventListener('click', function () {
  all('.refill-only').forEach(function (el) { el.hidden = false })
  all('[data-keep]').forEach(function (el) { el.checked = false })
  refill.hidden = true
  idle = '加密并提交'
  btnLabel.textContent = idle
  $('#eyebrow').textContent = '重新填写凭证'
  sync()
  var first = $('[data-field]')
  if (first) first.focus()
})
var ttl = $('#ttl'), end = Date.now() + MP.remainingMs
function tick() {
  if (!ttl) return
  var m = Math.ceil((end - Date.now()) / 60000)
  ttl.textContent = m > 0 ? '链接还剩 ' + m + ' 分钟' : '链接已过期'
}
tick()
setInterval(tick, 20000)
var LEVEL_NAME = { auto: '直接用', confirm: '点一下', passphrase: '主密码' }
function done(msg) {
  document.body.className = 'is-done'
  $('main').innerHTML = '<div class="done-box"><span class="done-icon">' + MP.check + '</span>'
    + '<h1>已收到</h1><p>' + msg + '</p><p>链接已失效，可以关掉了。</p></div>'
}
form.addEventListener('submit', async function (ev) {
  ev.preventDefault()
  if (btn.disabled) return
  say('')
  var payload = { uses: [], files: [] }
  all('[data-use]').forEach(function (el) { if (el.checked) payload.uses.push(MP.uses[Number(el.getAttribute('data-use'))]) })
  all('[data-file]').forEach(function (el) { if (el.checked) payload.files.push(MP.files[Number(el.getAttribute('data-file'))]) })
  var keep = []
  try {
    if (MP.mode !== 'approve') {
      keep = keptNames()
      var fields = {}, bad = []
      all('[data-field]').forEach(function (el) {
        var n = el.getAttribute('data-field')
        if (keep.indexOf(n) >= 0) return
        if (el.getAttribute('data-kind') !== 'text' && !el.value) bad.push(setErr(n, '这一项还没填'))
        fields[n] = el.value
      })
      if (needPassphrase()) {
        var p1 = $('#pp1').value, pm = ''
        if (!p1) pm = '请输入主密码'
        else if (!MP.passphraseSet && Array.from(p1).length < MP.passphraseMin) pm = '主密码至少 ' + MP.passphraseMin + ' 位'
        else if (!MP.passphraseSet && p1 !== $('#pp2').value) pm = '两次输入的不一样'
        if (pm) bad.push(setErr('__pp', pm))
        fields[${JSON.stringify(PASSPHRASE_FIELD)}] = p1
      }
      // Every problem is marked at once — not only the first — and the page
      // scrolls to the first of them.
      if (bad.length) {
        bad[0].scrollIntoView({ block: 'center', behavior: 'smooth' })
        say('还有几项没弄好，已经标红')
        return
      }
      payload.keep = keep
      payload.save = saveOn() ? { level: pick('level', 'auto'), days: Number(pick('days', '90')) } : null
      if (Object.keys(fields).length) {
        busy(true, '加密中…')
        var enc = await mpEncrypt(MP.serverKey, fields)
        payload.clientPub = enc.clientPub
        payload.salt = enc.salt
        payload.fields = enc.fields
      }
    }
    busy(true, '提交中…')
    var res = await fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    var body = null
    try { body = await res.json() } catch (e) {}
    if (!res.ok) {
      var m = (body && body.error) || ('提交失败（HTTP ' + res.status + '）')
      if (/主密码/.test(m) && $('#pp1')) setErr('__pp', m)
      throw new Error(m)
    }
    done(MP.mode === 'approve' ? '已批准，电脑那边可以接着用了。'
      : payload.save ? '值已经加密交给你的电脑，并按「' + LEVEL_NAME[payload.save.level] + '」保存在那台电脑上。'
      : keep.length === MP.fieldCount ? '用的是保存过的值，电脑那边可以接着用了。'
      : '值已经加密交给你的电脑，只留在内存里，没有保存。')
  } catch (err) {
    say(String(err && err.message || err))
    busy(false)
  }
})
`

export function renderFormPage({
  purpose, projectRoot = null, fields = [], saved = {}, uses = [], newUses = null, files = [],
  mode = 'fill', refill = false, save = { available: false, passphraseSet: false },
  savedFields = [], publicJwk = null, now = Date.now(), remainingMs = null,
}) {
  const approve = mode === 'approve'
  const confirm = mode === 'confirm'
  const eyebrow = approve ? '批准新的用途' : confirm ? '使用已保存的凭证' : '填写凭证'

  const savedLevels = fields.map((f) => saved[f.name]?.level).filter(Boolean)
  const preset = savedLevels.length
    ? { level: strictestLevel(savedLevels), days: presetDays(fields.map((f) => saved[f.name]).filter(Boolean)) }
    : null

  const chips = [
    projectRoot ? `<span class="chip" title="${esc(projectRoot)}">${ICON.folder}<span>${esc(basename(projectRoot))}</span></span>` : '',
    remainingMs !== null ? `<span class="chip">${ICON.clock}<span id="ttl"></span></span>` : '',
  ].join('')

  const fieldCard = approve
    ? '<section class="card"><h2 class="card-title">已保存的字段</h2>'
      + '<p class="card-sub" style="margin-bottom:0">值还在你电脑的内存里，这次不会重新传输。</p>'
      + `<ul class="names">${savedFields.map((n) => `<li class="mono">${esc(n)}</li>`).join('')}</ul></section>`
    : `<section class="card"><h2 class="card-title">${confirm ? '已保存的凭证' : '凭证'}</h2>`
      + `<div class="fields">${fields.map((f) => fieldHtml(f, saved, { mode, refill, now })).join('')}</div></section>`

  const items = uses.map((u, i) => useHtml(u, i, Boolean(newUses?.includes(u))))
    .concat(files.map((f, i) => fileHtml(f, i, projectRoot)))
  const usesCard = items.length
    ? `<section class="card"><h2 class="card-title">${approve ? '新的用途' : '允许 AI 用这些值'}</h2>`
      + '<p class="card-sub">只有打开的这几项能用这些值，AI 自己看不到值。</p>'
      + `<div class="list">${items.join('')}</div></section>`
    : (approve ? '' : '<section class="card"><h2 class="card-title">用途</h2><p class="card-sub" style="margin-bottom:0">'
      + 'AI 没有声明用途。之后它要用这些值时，会再发一条链接请你批准。</p></section>')

  const pp = approve ? '' : passphraseHtml(save)
  const saveCard = approve ? '' : saveHtml(save, { preset, confirm })
  // Confirm: the passphrase is what the page is asking for, so it sits right
  // under the saved fields. Fill: it belongs to the level just picked, so it
  // follows the save card.
  const body = confirm
    ? `${fieldCard}${pp}${usesCard}${saveCard}`
    : `${fieldCard}${usesCard}${saveCard}${pp}`
  const button = approve ? '批准' : confirm ? '使用已保存的值' : '加密并提交'
  const trust = approve
    ? '批准的只是用途，值不经过这个页面。'
    : '值在这台手机上加密后才发出，只有你电脑上的进程解得开；AI 只能按上面打开的用途使用。'

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><title>${esc(eyebrow)} — mobile-preview</title>
<style>${CSS}</style></head><body>
<main class="wrap">
<header class="hero"><div class="eyebrow">${ICON.lock}<span id="eyebrow">${esc(eyebrow)}</span></div>
<h1>${esc(purpose)}</h1><div class="meta">${chips}</div></header>
<form id="form" autocomplete="off" novalidate>
${body}
<p class="trust">${ICON.shield}<span>${trust}</span></p>
<div class="bar"><div id="status" class="status" role="status"></div>
<button id="submit" class="primary" type="submit"><span class="spin"></span><span class="btn-label">${button}</span></button>
${confirm ? '<button id="refill" class="ghost" type="button">重新填写</button>' : ''}</div>
</form>
</main>
<script>var MP=${jsonForScript({
    mode,
    uses,
    files: files.map((f) => f.key),
    serverKey: publicJwk,
    passphraseSet: Boolean(save.passphraseSet),
    passphraseMin: PASSPHRASE_MIN_LENGTH,
    fieldCount: fields.length,
    remainingMs: remainingMs ?? 0,
    check: ICON.check,
  })};${approve ? '' : BROWSER_ENCRYPT_JS}${PAGE_JS}</script>
</body></html>`
}

// An error the phone should see as written, rather than as "本机处理失败".
// `closeForm` also shuts the link — the passphrase limit is one of these.
export class FormError extends Error {
  constructor(message, { closeForm = false } = {}) {
    super(message)
    this.closeForm = closeForm
  }
}

export function createFormServer({
  purpose,
  projectRoot = null,
  fields = [],
  saved = {},
  uses = [],
  newUses = null,
  files = [],
  mode = 'fill',
  refill = false,
  save = { available: false, passphraseSet: false },
  savedFields = [],
  sessionHash,
  expiresAt,
  graceMs = 10 * 60_000,
  publicJwk = null,
  decrypt = null,
  onSubmit,
  maxBodyBytes = 64 * 1024,
  maxFailures = 10,
  failureWindowMs = 5 * 60_000,
}) {
  let submitted = false
  let busy = false

  const gate = createAccessGate({
    cookie: COOKIE,
    sessionHash,
    expiresAt,
    graceMs,
    // One submission, ever: after it the door is shut for good, not merely
    // for this request.
    closed: () => submitted,
    maxFailures,
    failureWindowMs,
  })

  // Rendered per request, not once: the countdown and "N 天前保存" are
  // relative to the moment the phone opens the page.
  const page = () => renderFormPage({
    purpose,
    projectRoot,
    fields,
    saved,
    uses,
    newUses,
    files,
    mode,
    refill,
    save,
    savedFields,
    publicJwk,
    now: Date.now(),
    remainingMs: Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : null,
  })
  const names = fields.map((f) => f.name)
  const fileKeys = files.map((f) => f.key)

  async function handleSubmit(req, res) {
    // One submission, ever. A second one — even a valid one from the same
    // phone — is refused the way everything else is: without saying why.
    if (submitted || busy) return notFound(res)
    busy = true
    try {
      let text
      try {
        text = await readBody(req, maxBodyBytes)
      } catch {
        return json(res, 413, { error: '提交内容过大' })
      }

      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        return json(res, 400, { error: '提交格式不对' })
      }
      if (!payload || typeof payload !== 'object') return json(res, 400, { error: '提交格式不对' })

      const chosen = Array.isArray(payload.uses) ? payload.uses : null
      if (!chosen || chosen.some((u) => typeof u !== 'string')) {
        return json(res, 400, { error: '用途列表格式不对' })
      }
      const approved = [...new Set(chosen)]
      if (approved.some((u) => !uses.includes(u))) {
        return json(res, 400, { error: '勾选了未提供的用途' })
      }

      const rawFiles = payload.files === undefined ? [] : payload.files
      if (!Array.isArray(rawFiles) || rawFiles.some((k) => typeof k !== 'string' || !fileKeys.includes(k))) {
        return json(res, 400, { error: '勾选了未提供的文件' })
      }
      const approvedFiles = [...new Set(rawFiles)]

      let values = null
      let keep = []
      let saveChoice = null
      let passphrase = null
      if (mode !== 'approve') {
        const rawKeep = payload.keep === undefined ? [] : payload.keep
        if (!Array.isArray(rawKeep) || rawKeep.some((n) => typeof n !== 'string' || !names.includes(n) || !saved[n])) {
          return json(res, 400, { error: '「使用已保存」的字段不对' })
        }
        keep = [...new Set(rawKeep)]
        const expected = names.filter((n) => !keep.includes(n))

        const hasEncrypted = payload.fields && typeof payload.fields === 'object' && Object.keys(payload.fields).length > 0
        values = {}
        if (expected.length || hasEncrypted) {
          try {
            values = decrypt(payload, expected)
          } catch (err) {
            return json(res, 400, { error: `解密失败：${err?.message || err}` })
          }
        }
        if (Object.hasOwn(values, PASSPHRASE_FIELD)) {
          passphrase = values[PASSPHRASE_FIELD]
          delete values[PASSPHRASE_FIELD]
        }
        for (const f of fields) {
          if (keep.includes(f.name)) continue
          const v = values[f.name]
          if (typeof v !== 'string') return json(res, 400, { error: `${f.name} 不是文本` })
          if (f.kind !== 'text' && v.length === 0) return json(res, 400, { error: `${f.name} 不能为空` })
        }

        if (payload.save !== undefined && payload.save !== null) {
          const s = payload.save
          if (!save.available) return json(res, 400, { error: '这台电脑不能保存' })
          if (typeof s !== 'object' || !LEVELS.includes(s.level) || !EXPIRY_DAYS.includes(s.days)) {
            return json(res, 400, { error: '保存选项不对' })
          }
          saveChoice = { level: s.level, days: s.days }
        }
      }

      try {
        await onSubmit?.({
          values, uses: approved, files: approvedFiles, keep, save: saveChoice, passphrase,
        })
      } catch (err) {
        if (err?.closeForm) submitted = true
        if (err instanceof FormError) return json(res, 400, { error: err.message })
        // The values are already in the daemon's hands or not at all; either
        // way the phone must not see a stack trace.
        return json(res, 500, { error: `本机处理失败：${err?.message || err}` })
      }
      submitted = true
      return json(res, 200, { ok: true })
    } finally {
      busy = false
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')

    if (!gate(req, res, url)) return undefined

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'",
      })
      res.end(page())
      return
    }

    if (req.method === 'POST' && url.pathname === '/submit') {
      handleSubmit(req, res)
      return
    }

    return notFound(res)
  })
}

export const SECRET_COOKIE = COOKIE
