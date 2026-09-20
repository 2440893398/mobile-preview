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
  var sending = false
  var pending = null
  var generation = 0
  var retryTimer = null
  // Five goes over about half a minute. Sized against what actually broke:
  // cloudflared losing the edge and coming back twenty-odd seconds later,
  // with the person still holding the phone, waiting for a receipt.
  var RETRY_DELAYS = [1200, 2500, 5000, 10000, 18000]

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

  function tell(text, tone) {
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
    // Three tones, because "still going" is not "it failed": a page that
    // says the same red thing while it retries has already told the person
    // their answer is lost.
    var back = tone === 'ok' ? '#166534' : (tone === 'wait' ? '#92400e' : '#9f1239')
    // Full-bleed bar, but its text lines up with the content column: on a
    // wide window a receipt pinned to the far bottom-left is nowhere near
    // where the person was just reading.
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;box-sizing:border-box;z-index:2147483647;'
      + 'padding:14px max(16px, calc((100% - var(--mp-content-width, 46rem)) / 2));'
      + 'font:15px/1.5 -apple-system,"SF Pro Text","PingFang SC","Noto Sans SC",sans-serif;color:#fff;'
      + 'background:' + back
    bar.textContent = text
  }

  // ---- the way back, for when the tunnel is not one ----
  //
  // Everything above assumes the phone can reach this machine. Sometimes it
  // cannot: cloudflared loses the edge for twenty seconds, the submit lands
  // in the hole, and the page tells someone to try again when what they
  // actually have to do is ask for a new link and fill the whole page in
  // again. Their answer was on the screen the entire time.
  //
  // So it is also written out as something they can paste into the chat
  // themselves, carrying the id, the revision and the values — one part a
  // person can read, one part an agent can parse. A broken wire then costs
  // one paste instead of one re-ask.

  function clean(s) {
    return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim()
  }

  function labelOf(el) {
    var lab = null
    if (el.id) {
      var labs = all('label', scope())
      for (var i = 0; i < labs.length; i += 1) {
        if (labs[i].htmlFor === el.id) { lab = labs[i]; break }
      }
    }
    if (!lab && el.closest) lab = el.closest('label')
    var t = lab ? lab.textContent : ''
    if (!t) t = el.getAttribute('aria-label') || el.getAttribute('title') || ''
    return clean(t).slice(0, 60)
  }

  // What the question was called, not what the chosen option was called: for
  // a radio group the input's own label is the option, so only a legend — or
  // the label of a lone free-text control — can stand in for the field.
  function fieldLabel(name, els) {
    for (var i = 0; i < els.length; i += 1) {
      var fs = els[i].closest ? els[i].closest('fieldset') : null
      var legend = fs ? fs.querySelector('legend') : null
      if (legend) return clean(legend.textContent).slice(0, 60)
    }
    if (els.length === 1) {
      var t = (els[0].type || '').toLowerCase()
      if (t !== 'radio' && t !== 'checkbox') {
        var own = labelOf(els[0])
        if (own) return own
      }
    }
    return name
  }

  function optionLabel(els, value) {
    for (var i = 0; i < els.length; i += 1) {
      var el = els[i]
      var t = (el.type || '').toLowerCase()
      if ((t === 'radio' || t === 'checkbox') && el.value === value) {
        var l = labelOf(el)
        if (l) return l
      }
      if (el.tagName === 'SELECT') {
        var opts = all('option', el)
        for (var j = 0; j < opts.length; j += 1) {
          if (opts[j].value === value) return clean(opts[j].textContent).slice(0, 60)
        }
      }
    }
    return null
  }

  function oneValue(els, v) {
    if (v === null || v === undefined || v === '') return '（空）'
    if (v === true) return '是'
    if (v === false) return '否'
    if (typeof v === 'object') return JSON.stringify(v)
    var label = optionLabel(els, String(v))
    if (label && label !== String(v)) return label + '（' + v + '）'
    return String(v)
  }

  function valueText(els, v) {
    if (Array.isArray(v)) {
      if (!v.length) return '（空）'
      return v.map(function (x) { return oneValue(els, x) }).join('、')
    }
    return oneValue(els, v)
  }

  // Past this the machine-readable copy stops being something anyone can
  // paste into a chat; the readable list above it still carries the answer.
  var HANDOFF_JSON_LIMIT = 6000

  function handoffText(disposition, reason) {
    var ans = collect()
    var byName = {}
    controls().forEach(function (el) {
      if (!byName[el.name]) byName[el.name] = []
      byName[el.name].push(el)
    })
    var lines = []
    Object.keys(ans).forEach(function (name) {
      var els = byName[name] || []
      lines.push('- ' + fieldLabel(name, els) + '：' + valueText(els, ans[name]).slice(0, 300))
    })
    if (!lines.length) lines.push('-（页面上还没填任何东西）')

    var payload = JSON.stringify({
      id: R.requestId,
      revision: R.revision || 1,
      disposition: disposition,
      reason: reason || null,
      answers: ans
    })
    var head = '【mp interaction 回传 · ' + R.requestId + ' · 第 ' + (R.revision || 1) + ' 版】'
    var why = disposition === 'answered'
      ? '手机上没能把答案交回你的机器。下面就是我的回答，按它继续，不用再发新链接。'
      : '手机上没能把这次回复交回你的机器。我的回复是 ' + disposition
        + (reason ? '（' + reason + '）' : '') + '，页面上填到这里：'
    return [
      head,
      why,
      '',
      lines.join('\\n'),
      '',
      payload.length > HANDOFF_JSON_LIMIT
        ? '（答案太长，机器可读的那份就不贴了，以上面这份为准）'
        : 'mp-answer: ' + payload,
      '',
      '收到后收个尾：mp interaction close --id ' + R.requestId
    ].join('\\n')
  }

  var panel = null

  function styleButton(b, primary) {
    b.type = 'button'
    b.style.cssText = 'flex:1 1 auto;min-height:44px;padding:10px 14px;border-radius:10px;'
      + 'font:15px/1.2 inherit;cursor:pointer;'
      + (primary
        ? 'border:0;background:#1d4ed8;color:#fff'
        : 'border:1px solid #cbd5e1;background:#fff;color:#0f172a')
  }

  function copyTo(clip, button) {
    var settled = function (label) {
      button.textContent = label
      setTimeout(function () { button.textContent = '复制' }, 2500)
    }
    var byHand = function () {
      try {
        clip.focus()
        clip.select()
        if (clip.setSelectionRange) clip.setSelectionRange(0, String(clip.value).length)
        if (document.execCommand && document.execCommand('copy')) return settled('已复制')
      } catch (e) { /* fall through to telling them to do it by hand */ }
      return settled('长按上面的文字复制')
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(clip.value).then(function () { settled('已复制') }, byHand)
        return
      }
    } catch (e) { /* no clipboard API: select it for them instead */ }
    byHand()
  }

  function rescue(disposition, reason) {
    var text = handoffText(disposition || 'answered', reason || null)
    if (panel) {
      panel.clip.value = text
      panel.root.hidden = false
      return text
    }

    var root = document.createElement('div')
    root.id = 'mp-handoff'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', '把答案手动回传')
    root.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;display:flex;'
      + 'align-items:flex-end;justify-content:center;background:rgba(15,23,42,.55);padding:12px;'
      + 'box-sizing:border-box;font:15px/1.6 -apple-system,"SF Pro Text","PingFang SC","Noto Sans SC",sans-serif'

    var card = document.createElement('div')
    card.style.cssText = 'width:100%;max-width:34rem;max-height:86vh;overflow:auto;box-sizing:border-box;'
      + 'background:#fff;color:#0f172a;border-radius:16px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.35)'

    var title = document.createElement('div')
    title.textContent = '提交没送到，这条路还通'
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:6px'

    var note = document.createElement('div')
    note.textContent = '复制下面这段话，回到和 AI 的对话里粘贴发出去，就等于你在这一页上答过了。'
      + '不用重新要链接，也不用再填一遍。'
    note.style.cssText = 'color:#475569;margin-bottom:10px'

    var clip = document.createElement('textarea')
    clip.readOnly = true
    clip.value = text
    clip.setAttribute('aria-label', '要粘贴回对话里的内容')
    clip.style.cssText = 'width:100%;height:12em;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;'
      + 'border-radius:10px;background:#f8fafc;color:#0f172a;resize:vertical;'
      + 'font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;-webkit-user-select:text;user-select:text'

    var row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px'

    var copy = document.createElement('button')
    copy.textContent = '复制'
    styleButton(copy, true)
    copy.addEventListener('click', function () { copyTo(clip, copy) })

    var again = document.createElement('button')
    again.textContent = '再试一次提交'
    styleButton(again, false)
    again.addEventListener('click', function () { retryNow() })

    var hide = document.createElement('button')
    hide.textContent = '回到页面'
    styleButton(hide, false)
    hide.addEventListener('click', function () { root.hidden = true })

    row.appendChild(copy)
    row.appendChild(again)
    row.appendChild(hide)
    card.appendChild(title)
    card.appendChild(note)
    card.appendChild(clip)
    card.appendChild(row)
    root.appendChild(card)
    document.body.appendChild(root)
    panel = { root: root, clip: clip }
    return text
  }

  // One attempt over the wire. This machine always answers JSON, so a body
  // that is not JSON did not come from it: it is cloudflared's own error page
  // from a tunnel that is reconnecting, or from a link that has lapsed.
  // Nothing was refused — it never arrived, which is a different thing, and
  // the only one worth retrying.
  function post(body) {
    return fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null
        try { data = JSON.parse(text) } catch (e) { data = null }
        if (!data || typeof data.status !== 'string') return { transport: true }
        return { data: data }
      })
    })['catch'](function () { return { transport: true } })
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      clearTimeout(retryTimer)
      retryTimer = setTimeout(resolve, ms)
    })
  }

  function enable() {
    all('[data-mp-submit]').forEach(function (b) { b.disabled = false })
  }

  function disable() {
    all('[data-mp-submit]').forEach(function (b) { b.disabled = true })
  }

  function landed(res) {
    done = true
    sending = false
    clearTimeout(saveTimer)
    clearTimeout(retryTimer)
    try { localStorage.removeItem(KEY) } catch (e) {}
    if (panel) panel.root.hidden = true
    tell('已提交，回执 ' + String(res.receiptId).slice(0, 8) + '。任务会接着往下走，这个页面可以关掉。', 'ok')
    document.dispatchEvent(new CustomEvent('mp:submitted', { detail: res }))
    return res
  }

  // Retried on its own, and safe to retry: the submission is idempotent on
  // responseId, so one that crosses a tunnel which has come back up gets the
  // same receipt rather than filing a second answer.
  function attemptSubmit(body, n, mine) {
    sending = true
    return post(body).then(function (r) {
      if (done || mine !== generation) return null
      var data = r.data

      if (data && data.status === 'submitted') return landed(data)

      if (data && data.status === 'stale') {
        sending = false
        enable()
        tell('这个页面不是最新的了，回到聊天里要一条新链接。', 'bad')
        return data
      }

      // This machine was reached and said no. A retry would be refused the
      // same way, so the way back is the only one left.
      if (data && (data.status === 'rejected' || data.status === 'error')) {
        sending = false
        enable()
        tell('这台机器没收下这次提交。用下面这段话直接回给 AI。', 'bad')
        rescue(body.disposition, body.reason)
        return data
      }

      // A busy reply is the other copy of this same submission still in
      // flight; anything else never reached this machine at all. Both are worth
      // another go, and the wait between goes is what carries a page across
      // a twenty-second reconnect.
      if (n < RETRY_DELAYS.length) {
        tell('提交没送出去，正在自动重试（' + (n + 1) + '/' + RETRY_DELAYS.length + '）……填的内容都还在。', 'wait')
        return sleep(RETRY_DELAYS[n]).then(function () {
          if (done || mine !== generation) return null
          return attemptSubmit(body, n + 1, mine)
        })
      }

      sending = false
      enable()
      tell('一直提交不上去，多半是隧道断了。用下面这段话直接回给 AI，就算回答了。', 'bad')
      rescue(body.disposition, body.reason)
      return null
    })
  }

  function retryNow() {
    if (done) return Promise.resolve(null)
    if (!pending) return submit('answered')
    clearTimeout(retryTimer)
    generation += 1
    if (panel) panel.root.hidden = true
    disable()
    tell('正在重试……', 'wait')
    return attemptSubmit(pending, 0, generation)
  }

  function submit(disposition, extra) {
    if (done || sending) return Promise.resolve(null)
    var d = disposition || 'answered'
    // Only a real answer has to be complete. "The premise is wrong" is often
    // exactly what someone wants to say before they can fill anything in.
    if (d === 'answered') {
      var gaps = missing()
      if (gaps.length) {
        gaps[0].setAttribute('aria-invalid', 'true')
        if (gaps[0].focus) gaps[0].focus()
        if (gaps[0].scrollIntoView) gaps[0].scrollIntoView({ block: 'center' })
        tell('还有必填项没填。', 'bad')
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

    pending = body
    generation += 1
    disable()
    return attemptSubmit(body, 0, generation)
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
    submit: submit,
    // The same text the page falls back to, for a page that would rather put
    // its own button on it.
    handoff: function (disposition, reason) { return handoffText(disposition || 'answered', reason || null) },
    rescue: function (disposition, reason) { return rescue(disposition, reason) }
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

// Injected, never authored — the counterpart to BRIDGE_JS, for layout.
//
// A page is written against the phone it was asked for: 390 px wide, one
// column, nothing capped. The same link then gets opened on a laptop, where a
// body with no width is a line of text as wide as the monitor — the one
// reading posture this command exists to improve. No page should have to
// remember the cap, so none is asked to.
//
// All of it is a default, not a rule. It sits first in `<head>`, so anything
// the page says later about images wins on order; the cap is written as
// `html body` (specificity 0,1,1) so it survives the `body{margin:0}` every
// page starts with, and is retuned by setting `--mp-content-width` or dropped
// entirely with `<body data-mp-layout="full">` for a deliberately full-bleed
// design. No media query: below the cap, `max-width` and `auto` side margins
// are both no-ops, so the phone renders exactly what it rendered before.
export const BASE_CSS = `
:root{--mp-content-width:46rem}
img,video,canvas{max-width:100%;height:auto}
html body:not([data-mp-layout="full"]){max-width:var(--mp-content-width);margin-left:auto;margin-right:auto}
`

// First inside <head>, so the page's own stylesheet comes after this one.
// Falling back down the tree rather than to the front of the file: a <style>
// ahead of <!doctype html> drops the page into quirks mode, which is a worse
// layout bug than the one being fixed.
function withBaseCss(html) {
  const s = String(html)
  const style = `<style data-mp-base>${BASE_CSS}</style>\n`

  // `[\s>]` and not a bare prefix: `<head` also matches the `<header>` of a
  // page that left `<head>` implicit, and the style would land inside it.
  for (const tag of [/<head[\s>]/i, /<html[\s>]/i]) {
    const m = tag.exec(s)
    if (!m) continue
    const close = s.indexOf('>', m.index)
    if (close < 0) continue
    return `${s.slice(0, close + 1)}\n${style}${s.slice(close + 1)}`
  }
  const body = /<body[\s>]/i.exec(s)
  if (body) return `${s.slice(0, body.index)}${style}${s.slice(body.index)}`
  return style + s
}

export function buildPage(html, request) {
  const page = withBaseCss(html)
  const tail = `\n<script>window.MP_REQUEST=${jsonForScript(request)}</script>\n<script>${BRIDGE_JS}</script>\n`
  const i = page.toLowerCase().lastIndexOf('</body>')
  if (i < 0) return page + tail
  return page.slice(0, i) + tail + page.slice(i)
}
