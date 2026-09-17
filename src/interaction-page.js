import { createHash } from 'node:crypto'

// The contract between a page and this CLI, in one file: what a page must
// satisfy to be served (checkPage), and what it may rely on once it is
// (BRIDGE_JS). The page itself is written by the model to whatever design
// standard it follows — nothing here has an opinion about how it looks.
//
// The split matters. Everything that can silently produce a page the user
// cannot answer on — an external font that never loads over a tunnel, a
// <form action> the CSP blocks, a module script that never runs — is a
// structural property, so it is checked before the link is handed out rather
// than discovered by the person holding the phone. Everything to do with
// collecting an answer and getting it back here is injected, so no page has
// to reimplement drafts, idempotency or receipts, and none of them can get
// it subtly wrong.
//
// Written up in docs/superpowers/specs/2026-09-16-interaction-page-contract.md.

export const MAX_PAGE_BYTES = 300 * 1024
export const MAX_ANSWER_BYTES = 256 * 1024

// answered — the user decided. needs_clarification — the question itself is
// wrong and the agent has to come back. declined — they will not answer.
// deferred — not now. The last three are the reason a page is more than a
// form: a request that can only be answered cannot be corrected.
export const DISPOSITIONS = ['answered', 'needs_clarification', 'declined', 'deferred']

// The unquoted branch is not pedantry: `<script src=https://cdn…></script>`
// is exactly how a hand-written page tends to come out, and a check that let
// it through would fail on the phone, silently, where the reason cannot be
// read — which is the one thing this file exists to prevent.
const EXTERNAL_REF = /<(script|link|img|iframe|video|audio|source|object|embed)\b[^>]*\s(?:src|href)\s*=\s*(?:["']([^"']*)["']|([^\s>"'`]+))/gi
const EXTERNAL_URL = /^(?:https?:)?\/\//i
// `url(//fonts…)` inherits the page's scheme and fetches just as much as
// `url(https://fonts…)` does.
const EXTERNAL_CSS_URL = /(?:@import\s+(?:url\()?|url\()\s*["']?(?:https?:)?\/\//i

export function contentDigest(html) {
  return createHash('sha256').update(String(html)).digest('hex').slice(0, 16)
}

// JSON that cannot close the <script> it is embedded in, and cannot be
// re-parsed as something else by a browser's line-terminator rules.
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029')
}

// Roughly a screen and a half of reading. Past this, a page that has drawn
// nothing is a chat message with margins — which is the thing this whole
// command exists to replace, so it is worth saying out loud even though it
// cannot be a hard failure: some questions really are text.
const PROSE_LIMIT = 260
// One CJK character carries about as much as an English word; nothing here
// needs to be more precise than that.
const CJK_CHAR = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/g

export function prose(html) {
  const text = String(html ?? '')
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
  const cjk = (text.match(CJK_CHAR) || []).length
  const latin = text.replace(CJK_CHAR, ' ').split(/\s+/).filter(Boolean).length
  return {
    words: cjk + latin,
    // `<figure>` is how a diagram drawn in HTML and CSS says it is one; inline
    // SVG says it by being one.
    drawn: /<svg\b/i.test(String(html ?? '')) || /<figure\b/i.test(String(html ?? '')),
  }
}

export function checkPage(html) {
  const text = String(html ?? '')
  const problems = []
  const warnings = []
  const bytes = Buffer.byteLength(text, 'utf8')

  if (!text.trim()) problems.push('the page is empty')
  if (bytes > MAX_PAGE_BYTES) {
    problems.push(`the page is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_PAGE_BYTES / 1024} KB `
      + '(it is inlined and served over a tunnel to a phone)')
  }
  if (!/^\s*<!doctype html>/i.test(text)) problems.push('missing `<!doctype html>` on the first line')
  if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(text)) {
    problems.push('missing `<meta name="viewport" content="width=device-width, initial-scale=1">` — '
      + 'without it the phone renders it at desktop width')
  }
  if (!/<html[^>]*\slang\s*=/i.test(text)) warnings.push('`<html>` has no lang attribute; CJK line breaking depends on it')
  if (!/<\/body>/i.test(text)) warnings.push('no `</body>`; the bridge will be appended at the end instead')

  // Nothing may be fetched from the network. The tunnel is the only route the
  // phone has to this machine, and it only reaches this page — a CDN font or
  // an <img> from the web either fails closed under the CSP or leaks the fact
  // that this page was opened to a third party.
  const external = []
  for (const m of text.matchAll(EXTERNAL_REF)) {
    const url = m[2] ?? m[3] ?? ''
    if (EXTERNAL_URL.test(url)) external.push(url)
  }
  if (external.length) {
    problems.push(`external resources are not allowed, found: ${[...new Set(external)].slice(0, 5).join(', ')}. `
      + 'Inline the styles and scripts; draw diagrams with HTML/CSS or inline SVG')
  }
  if (EXTERNAL_CSS_URL.test(text)) {
    problems.push('a stylesheet fetches an external URL; inline it instead')
  }
  if (/<base\b[^>]*\shref\s*=/i.test(text)) {
    problems.push('`<base href>` would repoint the bridge\'s /submit; remove it')
  }
  if (/<script[^>]*\stype\s*=\s*["']module["']/i.test(text)) {
    problems.push('`<script type="module">` cannot run here — the page is one inlined file under a strict CSP')
  }
  if (/<form\b[^>]*\saction\s*=/i.test(text)) {
    problems.push('`<form action>` is blocked by the CSP (`form-action \'none\'`); '
      + 'submit through an element with `data-mp-submit`')
  }
  if (/text\/babel/i.test(text) || /\bReactDOM\b/.test(text)) {
    problems.push('React and Babel are not available: they load from a CDN, and nothing may be fetched. '
      + 'Use plain HTML, CSS and JS')
  }

  if (!/data-mp-submit/.test(text)) {
    problems.push('nothing carries `data-mp-submit`, so the page has no way to submit')
  }
  const carriers = (text.match(/<(?:input|select|textarea)\b[^>]*\sname\s*=/gi) || []).length
    + (text.match(/data-mp-value/g) || []).length
    + (text.match(/MP\.set\s*\(/g) || []).length
  if (!carriers) {
    problems.push('no answer carriers: give controls a `name`, or set values with `data-mp-value` / `MP.set(name, value)`. '
      + 'Without one the submission would be empty')
  }
  if (/window\.MP_REQUEST\s*=/.test(text) || /window\.MP\s*=/.test(text)) {
    problems.push('the page defines `window.MP` or `window.MP_REQUEST`; both are injected — remove them')
  }
  if (!/data-mp-receipt/.test(text)) {
    warnings.push('no `[data-mp-receipt]` element; the bridge will append a fixed banner instead of placing the receipt')
  }
  const { words, drawn } = prose(text)
  if (words > PROSE_LIMIT && !drawn) {
    warnings.push(
      `this page is about ${words} words of prose with nothing drawn (no \`<svg>\`, no \`<figure>\`). `
      + 'A page exists to show what a chat cannot say: draw the comparison, the order, the before and '
      + 'after, and cut the paragraphs down to a line each. Paragraphs in a nicer font are still a wall '
      + 'of text, and the user has to read them on a phone',
    )
  }

  return { ok: problems.length === 0, problems, warnings, bytes }
}

// Injected, never authored. Written as ES5 with no template literals: it is
// embedded inside a template literal here, and it runs on whatever browser
// the phone happens to have.
export const BRIDGE_JS = `
(function () {
  'use strict'
  var R = window.MP_REQUEST || {}
  // Keyed by the page, not by the revision: the same question sent out again
  // after its link lapsed is the same page, and what they typed into it is
  // still their answer. A different page gets a different key, which is the
  // part that matters.
  var KEY = 'mp:draft:' + R.requestId + ':' + (R.contentDigest || R.revision)
  var store = {}
  var responseId = null
  var done = false
  var saveTimer = null
  var recovered = null

  function all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel))
  }
  function scope() {
    return document.querySelector('[data-mp-form]') || document.body
  }
  function controls() {
    return all('input[name],select[name],textarea[name]', scope())
  }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k) }

  function readControl(el, siblings) {
    var t = (el.type || '').toLowerCase()
    if (t === 'checkbox') {
      var group = siblings.filter(function (o) {
        return o.name === el.name && (o.type || '').toLowerCase() === 'checkbox'
      })
      if (group.length > 1) {
        return group.filter(function (o) { return o.checked }).map(function (o) { return o.value })
      }
      return el.checked
    }
    if (t === 'radio') {
      var on = siblings.filter(function (o) { return o.name === el.name && o.checked })[0]
      return on ? on.value : null
    }
    if (el.tagName === 'SELECT' && el.multiple) {
      return all('option', el).filter(function (o) { return o.selected }).map(function (o) { return o.value })
    }
    if (t === 'number') return el.value === '' ? null : Number(el.value)
    return el.value
  }

  function collect() {
    var out = {}
    var list = controls()
    list.forEach(function (el) {
      if (!has(out, el.name)) out[el.name] = readControl(el, list)
    })
    all('[data-mp-value][name]', scope()).forEach(function (el) {
      var raw = el.getAttribute('data-mp-value')
      try { out[el.getAttribute('name')] = JSON.parse(raw) } catch (e) { out[el.getAttribute('name')] = raw }
    })
    Object.keys(store).forEach(function (k) { out[k] = store[k] })
    return out
  }

  function restore(answers) {
    if (!answers) return
    var list = controls()
    list.forEach(function (el) {
      if (!has(answers, el.name)) return
      var v = answers[el.name]
      var t = (el.type || '').toLowerCase()
      if (t === 'checkbox') el.checked = Array.isArray(v) ? v.indexOf(el.value) >= 0 : Boolean(v)
      else if (t === 'radio') el.checked = el.value === v
      else if (v !== null && v !== undefined) el.value = v
    })
    all('[data-mp-value][name]', scope()).forEach(function (el) {
      var n = el.getAttribute('name')
      if (has(answers, n)) el.setAttribute('data-mp-value', JSON.stringify(answers[n]))
    })
  }

  // Two copies, for two different failures. localStorage survives the tab
  // being closed or the phone locking; the copy on the machine survives the
  // phone itself going away, and is what \`mp interaction wait\` reports back
  // so the agent can say what is already filled in.
  function save() {
    if (done) return
    var answers = collect()
    try {
      localStorage.setItem(KEY, JSON.stringify({
        answers: answers, store: store, responseId: responseId, savedAt: Date.now()
      }))
    } catch (e) { /* private mode or quota: the server copy still goes out */ }
    clearTimeout(saveTimer)
    saveTimer = setTimeout(function () {
      try {
        fetch('/draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: R.requestId, revision: R.revision, answers: answers })
        })['catch'](function () {})
      } catch (e) {}
    }, 800)
  }

  function missing() {
    return all('[required]', scope()).filter(function (el) {
      var t = (el.type || '').toLowerCase()
      if (t === 'checkbox' || t === 'radio') {
        return !all('[name="' + el.name + '"]', scope()).some(function (o) { return o.checked })
      }
      return !String(el.value == null ? '' : el.value).trim()
    })
  }

  function tell(text, ok) {
    var target = document.querySelector('[data-mp-receipt]')
    if (target) {
      target.textContent = text
      target.hidden = false
      return
    }
    var bar = document.getElementById('mp-receipt-bar')
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'mp-receipt-bar'
      bar.setAttribute('role', 'status')
      document.body.appendChild(bar)
    }
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:14px 16px;z-index:2147483647;'
      + 'font:15px/1.5 -apple-system,"SF Pro Text","PingFang SC","Noto Sans SC",sans-serif;color:#fff;'
      + 'background:' + (ok ? '#166534' : '#9f1239')
    bar.textContent = text
  }

  function submit(disposition, extra) {
    if (done) return Promise.resolve(null)
    var d = disposition || 'answered'
    // Only a real answer has to be complete. "The premise is wrong" is often
    // exactly what someone wants to say before they can fill anything in.
    if (d === 'answered') {
      var gaps = missing()
      if (gaps.length) {
        gaps[0].setAttribute('aria-invalid', 'true')
        if (gaps[0].focus) gaps[0].focus()
        if (gaps[0].scrollIntoView) gaps[0].scrollIntoView({ block: 'center' })
        tell('还有必填项没填。', false)
        return Promise.resolve(null)
      }
    }
    if (!responseId) {
      responseId = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    }
    var body = {
      requestId: R.requestId,
      revision: R.revision,
      contentDigest: R.contentDigest,
      responseId: responseId,
      disposition: d,
      answers: collect()
    }
    if (extra) for (var k in extra) if (has(extra, k)) body[k] = extra[k]

    var buttons = all('[data-mp-submit]')
    buttons.forEach(function (b) { b.disabled = true })

    return fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json()['catch'](function () { return { status: 'error' } })
    }).then(function (res) {
      if (res && res.status === 'submitted') {
        done = true
        clearTimeout(saveTimer)
        try { localStorage.removeItem(KEY) } catch (e) {}
        tell('已提交，回执 ' + String(res.receiptId).slice(0, 8) + '。任务会接着往下走，这个页面可以关掉。', true)
        document.dispatchEvent(new CustomEvent('mp:submitted', { detail: res }))
        return res
      }
      // The other copy of this same submission is still in flight, or has
      // already succeeded. Either way it, not this one, has the last word:
      // saying "it failed" here would be saying it about an answer that
      // arrived.
      if (done || (res && res.status === 'busy')) return res
      buttons.forEach(function (b) { b.disabled = false })
      tell(res && res.status === 'stale'
        ? '这个页面不是最新的了，回到聊天里要一条新链接。'
        : '没有提交成功，再试一次。', false)
      return res
    })['catch'](function () {
      if (done) return null
      buttons.forEach(function (b) { b.disabled = false })
      tell('提交失败，可能是网络断了。恢复后再点一次，填的内容还在。', false)
      return null
    })
  }

  window.MP = {
    set: function (name, value) { store[name] = value; save() },
    get: function (name) { return has(store, name) ? store[name] : collect()[name] },
    draft: function (name) {
      var d = recovered || local()
      if (!d || !d.answers) return undefined
      return d.answers[name]
    },
    answers: collect,
    submit: submit
  }

  function local() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch (e) { return null }
  }

  // The phone's copy first — it is the newest, and it is already here. Only
  // when there is none does the machine's copy matter, and then it matters a
  // lot: a link opened again in a different browser has no localStorage to
  // read, and without this the work is simply gone.
  function recover(then) {
    var d = local()
    if (d) return then(d)
    var timer = setTimeout(function () { timer = null; then(null) }, 2500)
    try {
      fetch('/state', { headers: { Accept: 'application/json' } })
        .then(function (res) { return res.json() })
        .then(function (s) {
          if (!timer) return
          clearTimeout(timer)
          timer = null
          then(s && s.draft ? { answers: s.draft.answers } : null)
        })['catch'](function () {
          if (!timer) return
          clearTimeout(timer)
          timer = null
          then(null)
        })
    } catch (e) {
      clearTimeout(timer)
      timer = null
      then(null)
    }
    return undefined
  }

  function begin(d) {
    recovered = d
    if (d) {
      restore(d.answers)
      // Anything in the draft that no control on this page answers for came
      // from MP.set, and has to go back there — the machine's copy has the
      // values but not the store they were kept in, and a sortable list that
      // came back on screen but not into the answer is the worst of both.
      var named = {}
      controls().forEach(function (el) { named[el.name] = true })
      all('[data-mp-value][name]', scope()).forEach(function (el) { named[el.getAttribute('name')] = true })
      Object.keys(d.answers || {}).forEach(function (k) {
        if (!named[k]) store[k] = d.answers[k]
      })
      if (d.store) Object.keys(d.store).forEach(function (k) { store[k] = d.store[k] })
      responseId = d.responseId || null
    }
    scope().addEventListener('input', save, true)
    scope().addEventListener('change', save, true)
    document.addEventListener('click', function (ev) {
      var t = ev.target
      var b = t && t.closest ? t.closest('[data-mp-submit]') : null
      if (!b) return
      ev.preventDefault()
      var extra = {}
      var reason = b.getAttribute('data-mp-reason')
      if (reason) extra.reason = reason
      submit(b.getAttribute('data-mp-disposition') || 'answered', extra)
    })
    // Custom controls restore themselves here: by now MP.draft can see the
    // saved values, and the native controls already have theirs back.
    document.dispatchEvent(new CustomEvent('mp:ready'))
  }

  function start() { recover(begin) }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
`

export function buildPage(html, request) {
  const tail = `\n<script>window.MP_REQUEST=${jsonForScript(request)}</script>\n<script>${BRIDGE_JS}</script>\n`
  const i = String(html).toLowerCase().lastIndexOf('</body>')
  if (i < 0) return html + tail
  return html.slice(0, i) + tail + html.slice(i)
}
