import { createServer } from 'node:http'
import { createAccessGate, json, notFound, readBody } from './http-util.js'
import { DISPOSITIONS, MAX_ANSWER_BYTES, buildPage } from './interaction-page.js'

// Serves one interaction page to one phone, behind the same front door as the
// secret form, and takes two things back from it: drafts while the user is
// still working, and one answer when they are done.
//
// The page is served under a CSP that permits nothing but what is already
// inside it. `img-src data:` is the one addition over the secret form's — a
// page explaining a decision may need an inline diagram, and a data: URI is
// still nothing fetched from the network.

const COOKIE = 'mp_interaction'
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "img-src data:; connect-src 'self'; form-action 'none'"

export function createInteractionServer({
  html,
  requestId,
  revision = 1,
  contentDigest,
  sessionHash,
  expiresAt,
  graceMs = 10 * 60_000,
  draft = () => null,
  onDraft = null,
  onSubmit,
  maxBodyBytes = MAX_ANSWER_BYTES,
  maxFailures = 10,
  failureWindowMs = 5 * 60_000,
}) {
  const page = buildPage(html, { requestId, revision, contentDigest })
  let answered = false
  let busy = false

  // Deliberately not `closed: () => answered`. The phone's retry after a 200
  // that never crossed the tunnel carries the same responseId and must get
  // the same receipt back; a closed door would answer it 404 and the user
  // would be told their answer failed after it had already arrived. Closing
  // for good is a per-route decision below, and /submit is not one of them.
  const gate = createAccessGate({
    cookie: COOKIE,
    sessionHash,
    expiresAt,
    graceMs,
    maxFailures,
    failureWindowMs,
  })

  async function body(req, res) {
    let text
    try {
      text = await readBody(req, maxBodyBytes)
    } catch {
      json(res, 413, { status: 'rejected', error: '提交内容过大' })
      return null
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      json(res, 400, { status: 'rejected', error: '提交格式不对' })
      return null
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      json(res, 400, { status: 'rejected', error: '提交格式不对' })
      return null
    }
    // A stale tab from a previous revision must not overwrite the current
    // one's draft or answer with values collected against a different page.
    if (payload.requestId !== requestId) {
      json(res, 400, { status: 'rejected', error: '这条链接对应的问题已经不在了' })
      return null
    }
    return payload
  }

  function answers(payload) {
    const a = payload.answers
    return a && typeof a === 'object' && !Array.isArray(a) ? a : null
  }

  async function handleDraft(req, res) {
    if (answered) return notFound(res)
    const payload = await body(req, res)
    if (!payload) return
    const a = answers(payload)
    if (!a) return json(res, 400, { status: 'rejected', error: '答案格式不对' })
    try {
      onDraft?.({ revision: payload.revision, answers: a })
    } catch {
      // A draft is a convenience. Losing one must not make the page look
      // broken to someone in the middle of filling it in.
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' })
    res.end()
  }

  async function handleSubmit(req, res) {
    // One answer at a time, and one answer in the end. A double-tap on the
    // phone arrives as two requests; `busy` stops the second before it can
    // mint a second receipt for the same responseId. It says so rather than
    // 404ing: this is the retry the receipt memo exists to serve, and a page
    // that read it as a failure would tell someone their answer was lost a
    // moment before the first request lands and says it arrived.
    if (busy) return json(res, 409, { status: 'busy', error: '正在提交，稍等一下' })
    busy = true
    try {
      const payload = await body(req, res)
      if (!payload) return undefined

      const a = answers(payload)
      if (!a) return json(res, 400, { status: 'rejected', error: '答案格式不对' })
      if (typeof payload.responseId !== 'string' || !payload.responseId.trim()) {
        return json(res, 400, { status: 'rejected', error: '缺少提交编号' })
      }
      if (!DISPOSITIONS.includes(payload.disposition)) {
        return json(res, 400, { status: 'rejected', error: '提交类型不对' })
      }
      // The page was replaced while this tab had it open — a re-ask after
      // "the premise is wrong". Answering the old question would be worse
      // than saying so.
      if (payload.contentDigest !== contentDigest) {
        return json(res, 409, { status: 'stale', error: '页面已经不是最新的了' })
      }

      let result
      try {
        result = onSubmit({
          responseId: payload.responseId,
          disposition: payload.disposition,
          answers: a,
          reason: typeof payload.reason === 'string' ? payload.reason : null,
        })
      } catch (err) {
        return json(res, 500, { status: 'error', error: `本机处理失败：${err?.message || err}` })
      }

      // A second, different answer to a question already answered. Only a
      // stale tab can produce one, and it is told so rather than silently
      // replacing what the agent may already have acted on.
      if (result?.conflict) return json(res, 409, { status: 'stale', error: '这个问题已经回答过了' })

      if (!result.duplicate) answered = true
      return json(res, 200, { status: 'submitted', receiptId: result.receiptId, duplicate: Boolean(result.duplicate) })
    } finally {
      busy = false
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')

    if (!gate(req, res, url)) return undefined

    if (req.method === 'GET' && url.pathname === '/') {
      if (answered) return notFound(res)
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': CSP,
      })
      res.end(page)
      return undefined
    }
    // The draft this machine holds, for a page that cannot find one on the
    // phone: a link opened first in a chat app's built-in browser and then
    // again in Safari is two localStorages and one person, who typed their
    // answer once.
    if (req.method === 'GET' && url.pathname === '/state') {
      if (answered) return notFound(res)
      return json(res, 200, { status: 'waiting', requestId, revision, draft: draft() })
    }
    if (req.method === 'POST' && url.pathname === '/draft') return handleDraft(req, res)
    if (req.method === 'POST' && url.pathname === '/submit') return handleSubmit(req, res)

    return notFound(res)
  })
}

export const INTERACTION_COOKIE = COOKIE
export const INTERACTION_CSP = CSP
