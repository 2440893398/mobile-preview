import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture } from '../src/capture.js'

let server
let base
let outDir

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/broken.js') {
      res.writeHead(500, { 'Content-Type': 'application/javascript' })
      return res.end('boom')
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset=utf-8>
      <h1 id=t>capture target</h1>
      <script>console.error('deliberate console error')</script>
      <script src="/broken.js"></script>`)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  outDir = mkdtempSync(join(tmpdir(), 'mp-cap-'))
})

after(() => {
  server.close()
  rmSync(outDir, { recursive: true, force: true })
})

test('produces a screenshot file and reports its basename', async () => {
  const r = await capture({ url: base, outDir })
  assert.equal(r.shots.length, 1)
  assert.equal(r.shots[0], 'shot-1.png')
  assert.ok(existsSync(join(outDir, 'shot-1.png')), 'screenshot must exist on disk')
})

test('collects console errors for the agent to self-check', async () => {
  const r = await capture({ url: base, outDir })
  assert.ok(
    r.consoleErrors.some((e) => e.includes('deliberate console error')),
    `expected the console error, got ${JSON.stringify(r.consoleErrors)}`,
  )
})

test('collects failing network responses', async () => {
  const r = await capture({ url: base, outDir })
  assert.ok(
    r.failedRequests.some((f) => f.url.endsWith('/broken.js') && f.status === 500),
    `expected the 500, got ${JSON.stringify(r.failedRequests)}`,
  )
})

test('records a video when asked', async () => {
  const r = await capture({ url: base, outDir, video: true })
  assert.equal(r.video, 'reel.mp4')
  assert.ok(existsSync(join(outDir, r.video)), 'video must exist on disk')
})

test('an unreachable url rejects rather than returning an empty result', async () => {
  await assert.rejects(() => capture({ url: 'http://127.0.0.1:1', outDir }))
})
