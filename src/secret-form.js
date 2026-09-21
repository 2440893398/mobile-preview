import { createServer } from 'node:http'
import { createAccessGate, json, notFound, readBody } from './http-util.js'
import { BROWSER_ENCRYPT_JS } from './secret-crypto.js'

// The page a phone opens to hand values to the daemon. It borrows the
// preview proxy's authentication wholesale — token exchange, grace window,
// 404 on every failure, per-IP limiter — and adds exactly one thing the proxy
// does not have: a body. Bare node:http, no framework, fail closed.

const COOKIE = 'mp_secret'

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

// JSON inside a <script> must not be able to close the tag.
function jsonForScript(v) {
  return JSON.stringify(v).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

const CSS = `
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
body{margin:0;padding:20px 16px 40px;max-width:520px;margin:0 auto;line-height:1.5}
h1{font-size:18px;margin:0 0 4px}
.purpose{font-size:15px;margin:0 0 20px;opacity:.85}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 4px;word-break:break-all}
input[type=text],input[type=password],textarea{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border:1px solid #8884;border-radius:8px;background:transparent;color:inherit}
textarea{min-height:88px;font-family:ui-monospace,Menlo,monospace}
.row{display:flex;gap:8px;align-items:center}
.row input{flex:1}
.toggle{font-size:13px;padding:8px 10px;border:1px solid #8884;border-radius:8px;background:transparent;color:inherit}
h2{font-size:14px;margin:24px 0 6px}
.use{display:flex;gap:10px;align-items:flex-start;padding:8px 0;font-size:14px}
.use input{margin-top:3px;width:18px;height:18px}
.use code{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all}
.saved{font-size:13px;opacity:.75;margin:0;padding-left:18px}
button.submit{display:block;width:100%;margin-top:24px;padding:14px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:#2563eb;color:#fff}
button.submit:disabled{opacity:.5}
.note{font-size:12px;opacity:.7;margin-top:16px}
.status{margin-top:14px;font-size:14px;min-height:1.5em}
.done h1{font-size:20px}
`

function fieldHtml({ name, kind }) {
  const id = `f-${name}`
  if (kind === 'multiline') {
    return `<label for="${esc(id)}">${esc(name)}</label>`
      + `<textarea id="${esc(id)}" data-field="${esc(name)}" data-kind="${esc(kind)}" autocomplete="off" spellcheck="false" required></textarea>`
  }
  const type = kind === 'text' ? 'text' : 'password'
  const req = kind === 'text' ? '' : ' required'
  const toggle = kind === 'text' ? '' : `<button type="button" class="toggle" data-toggle="${esc(id)}">显示</button>`
  return `<label for="${esc(id)}">${esc(name)}</label>`
    + `<div class="row"><input id="${esc(id)}" type="${type}" data-field="${esc(name)}" data-kind="${esc(kind)}" `
    + `autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"${req}>${toggle}</div>`
}

function useHtml(use, i) {
  return `<label class="use"><input type="checkbox" data-use="${i}" checked><code>${esc(use)}</code></label>`
}

// The message line is `statusEl`, never `status`: at the top level of a page
// that name is window.status, a legacy string property, and every
// `.textContent =` on it vanished without an error. Since 0.4.0 the form
// showed no message at all — not "加密并提交中…", not a server's 400 — which
// only driving it in a real mobile browser turned up (2026-09-21).
const PAGE_JS = `
document.querySelectorAll('[data-toggle]').forEach(function (b) {
  b.addEventListener('click', function () {
    var i = document.getElementById(b.getAttribute('data-toggle'))
    var show = i.type === 'password'
    i.type = show ? 'text' : 'password'
    b.textContent = show ? '隐藏' : '显示'
  })
})
var form = document.getElementById('form')
var statusEl = document.getElementById('status')
form.addEventListener('submit', async function (ev) {
  ev.preventDefault()
  var btn = document.getElementById('submit')
  btn.disabled = true
  statusEl.textContent = '加密并提交中…'
  try {
    var fields = {}
    document.querySelectorAll('[data-field]').forEach(function (el) {
      fields[el.getAttribute('data-field')] = el.value
    })
    var uses = []
    document.querySelectorAll('[data-use]').forEach(function (el) {
      if (el.checked) uses.push(MP.uses[Number(el.getAttribute('data-use'))])
    })
    var payload = { uses: uses }
    if (MP.mode === 'fill') {
      var enc = await mpEncrypt(MP.serverKey, fields)
      payload.clientPub = enc.clientPub
      payload.salt = enc.salt
      payload.fields = enc.fields
    }
    var res = await fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    var body = null
    try { body = await res.json() } catch (e) {}
    if (!res.ok) {
      throw new Error((body && body.error) || ('提交失败（HTTP ' + res.status + '）'))
    }
    document.body.className = 'done'
    document.body.innerHTML = '<h1>已收到</h1><p>值已经交给这台电脑上的进程，这个页面可以关掉了。</p>'
      + '<p class="note">这条链接现在已经失效。</p>'
  } catch (err) {
    statusEl.textContent = String(err && err.message || err)
    btn.disabled = false
  }
})
`

export function renderFormPage({
  purpose, fields = [], uses = [], mode = 'fill', savedFields = [], publicJwk = null,
}) {
  const fill = mode === 'fill'
  const title = fill ? '填写凭证' : '批准新的用途'
  const fieldBlock = fill
    ? fields.map(fieldHtml).join('')
    : `<h2>已保存的字段（不会显示）</h2><ul class="saved">${savedFields.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
  const usesBlock = uses.length
    ? `<h2>${fill ? '允许 AI 用这些值运行：' : '新增用途：'}</h2>${uses.map(useHtml).join('')}`
    : `<p class="note">${fill ? 'AI 没有声明用途。之后它需要用这些值时，会再发一条链接请你批准。' : ''}</p>`

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} — mobile-preview</title>
<style>${CSS}</style></head><body>
<h1>${esc(title)}</h1>
<p class="purpose">${esc(purpose)}</p>
<form id="form" autocomplete="off">
${fieldBlock}
${usesBlock}
<button id="submit" class="submit" type="submit">${fill ? '加密并提交' : '批准'}</button>
<div id="status" class="status" role="status"></div>
<p class="note">${fill
    ? '每个值都在本机浏览器里加密后才发送；只有你电脑上的进程能解开。AI 拿不到值，只能按上面勾选的用途使用。'
    : '值仍在你电脑的进程内存里，没有重新传输。'}</p>
</form>
<script>var MP=${jsonForScript({ mode, uses, serverKey: publicJwk })};${fill ? BROWSER_ENCRYPT_JS : ''}${PAGE_JS}</script>
</body></html>`
}

export function createFormServer({
  purpose,
  fields = [],
  uses = [],
  mode = 'fill',
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

  const page = renderFormPage({ purpose, fields, uses, mode, savedFields, publicJwk })
  const names = fields.map((f) => f.name)

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

      let values = null
      if (mode === 'fill') {
        try {
          values = decrypt(payload)
        } catch (err) {
          return json(res, 400, { error: `解密失败：${err?.message || err}` })
        }
        for (const f of fields) {
          const v = values[f.name]
          if (typeof v !== 'string') return json(res, 400, { error: `${f.name} 不是文本` })
          if (f.kind !== 'text' && v.length === 0) return json(res, 400, { error: `${f.name} 不能为空` })
        }
      }

      submitted = true
      try {
        onSubmit?.({ values, uses: approved })
      } catch (err) {
        // The values are already in the daemon's hands or not at all; either
        // way the phone must not see a stack trace.
        return json(res, 500, { error: `本机处理失败：${err?.message || err}` })
      }
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
      res.end(page)
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
