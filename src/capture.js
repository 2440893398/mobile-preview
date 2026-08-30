import { chromium, devices } from 'playwright'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findBrowserExecutable } from './browser.js'
import { resolveCommand } from './locate.js'

function convertVideoToMp4(input, output) {
  const ffmpeg = resolveCommand('ffmpeg')
  if (!ffmpeg) {
    throw new Error('ffmpeg not found. Install ffmpeg to use --video.')
  }

  const result = spawnSync(ffmpeg, [
    '-y',
    '-i', input,
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
    // Same reason as the cloudflared spawn in tunnel.js: capture runs from the
    // CLI (where this flashes a console window open and shut) and could run
    // from the console-less daemon (where it would open one and keep it).
  ], { encoding: 'utf8', windowsHide: true })

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`
    throw new Error(`ffmpeg failed to convert video: ${detail}`)
  }
}

// Requests the browser makes on its own account, or that only a build tool
// cares about. A 404 here is normal on a dev server and says nothing about
// whether the app works — reporting it at the same volume as a missing entry
// script is what made "404 (Not Found)" unactionable in the first place.
const IGNORABLE = [
  /\/favicon\.[a-z0-9]+(\?|$)/i,
  /\/apple-touch-icon[^/]*(\?|$)/i,
  /\.map(\?|$)/i,
  /\/robots\.txt(\?|$)/i,
  /\/\.well-known\//i,
]

export function classifySeverity(url) {
  return IGNORABLE.some((re) => re.test(String(url))) ? 'warning' : 'error'
}

const EXT_TYPES = [
  [/\.map(\?|$)/i, 'sourcemap'],
  [/\.(m?[jt]sx?)(\?|$)/i, 'script'],
  [/\.css(\?|$)/i, 'stylesheet'],
  [/\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|$)/i, 'image'],
  [/\.(woff2?|ttf|otf|eot)(\?|$)/i, 'font'],
]

export function guessResourceType(url) {
  return EXT_TYPES.find(([re]) => re.test(String(url)))?.[1] || 'other'
}

const RESOURCE_ERROR_RE = /^Failed to load resource/i
const STATUS_RE = /status of (\d{3})/i
const NET_ERROR_RE = /(net::[A-Z_]+)/

// "Failed to load resource: the server responded with a status of 404" with no
// url attached is the single least useful line a capture can produce, and it is
// what the browser prints. Chromium does attach the url — on the console
// message's *location*, not in its text — so pair the two back up here: fold
// each such console line into the matching request record, and when no request
// record exists (the response listener does not see every browser-initiated
// fetch), synthesise one from the console line rather than dropping the url on
// the floor. Pure so it can be tested without a browser.
export function correlateResourceErrors({ consoleErrors = [], failedRequests = [] }) {
  const requests = failedRequests.map((f) => ({ ...f }))
  const byUrl = new Map()
  for (const f of requests) if (!byUrl.has(f.url)) byUrl.set(f.url, f)

  const remaining = []

  for (const entry of consoleErrors) {
    const text = typeof entry === 'string' ? entry : entry?.text
    const url = typeof entry === 'string' ? null : entry?.url

    if (!url || !RESOURCE_ERROR_RE.test(String(text || ''))) {
      remaining.push(entry)
      continue
    }

    const known = byUrl.get(url)
    if (known) {
      known.consoleText = text
      continue
    }

    const status = STATUS_RE.exec(text)
    const net = NET_ERROR_RE.exec(text)
    const synthesised = {
      url,
      ...(status ? { status: Number(status[1]) } : { error: net ? net[1] : 'failed' }),
      resourceType: guessResourceType(url),
      consoleText: text,
      fromConsole: true,
    }
    byUrl.set(url, synthesised)
    requests.push(synthesised)
  }

  return { consoleErrors: remaining, failedRequests: requests }
}

// Keyed by url, not by url+status. One missing script produces up to three
// records — the 404 response, a `requestfailed` with net::ERR_ABORTED because
// the load failed, and the console line — and listing all three makes one
// missing file look like three problems. Merge them, keeping the http status,
// which is the part that explains the other two.
export function dedupeRequests(failedRequests) {
  const byUrl = new Map()

  for (const f of failedRequests) {
    const prior = byUrl.get(f.url)
    if (!prior) {
      byUrl.set(f.url, { ...f })
      continue
    }

    const merged = { ...prior }
    for (const [k, v] of Object.entries(f)) {
      if (v !== undefined && merged[k] === undefined) merged[k] = v
    }
    if (merged.status !== undefined) delete merged.error
    byUrl.set(f.url, merged)
  }

  return [...byUrl.values()]
}

function summarise(consoleErrors, failedRequests) {
  const parts = []
  if (failedRequests.length) {
    const worst = failedRequests
      .filter((f) => classifySeverity(f.url) === 'error')
      .slice(0, 3)
      .map((f) => `${f.status ?? f.error} ${f.url}`)
    parts.push(`${failedRequests.length} failed request(s)${worst.length ? `: ${worst.join(', ')}` : ''}`)
  }
  if (consoleErrors.length) parts.push(`${consoleErrors.length} console error(s)`)
  return parts.length ? ` Seen so far: ${parts.join('; ')}.` : ' The page produced no failed requests or console errors, so it is most likely still rendering.'
}

// Artifact names are numbered off what is already in the gallery, not fixed:
// a fixed `shot-1.png` meant every capture overwrote the previous one, and a
// markdown link already sitting in someone's chat silently changed content.
// The number is the highest existing index + 1, so deleting nothing and
// racing nothing.
function nextArtifactName(outDir, re, render) {
  let max = 0
  try {
    for (const name of readdirSync(outDir)) {
      const m = re.exec(name)
      if (m) max = Math.max(max, Number(m[1] ?? 1))
    }
  } catch {
    // Unreadable dir — mkdirSync below will surface the real problem.
  }
  return render(max + 1)
}

function nextShotName(outDir) {
  return nextArtifactName(outDir, /^shot-(\d+)\.png$/, (n) => `shot-${n}.png`)
}

// The first video keeps the historical bare name; later ones are numbered.
function nextVideoName(outDir) {
  return nextArtifactName(
    outDir,
    /^reel(?:-(\d+))?\.mp4$/,
    (n) => (n === 1 ? 'reel.mp4' : `reel-${n}.mp4`),
  )
}

// Exported so the CLI can reject an unknown --device instead of silently
// serving an iPhone 13 screenshot to someone who asked for a Pixel.
export function knownDevice(name) {
  return Object.hasOwn(devices, String(name))
}

export async function capture({
  url,
  outDir,
  steps = null,
  video = false,
  deviceName = 'iPhone 13',
  waitFor = null,
  waitMs = 500,
  networkIdle = false,
  fullPage = false,
  timeoutMs = 30_000,
}) {
  mkdirSync(outDir, { recursive: true })

  const device = devices[deviceName] || devices['iPhone 13']
  const viewport = device.viewport || { width: 390, height: 844 }

  const executablePath = findBrowserExecutable()
  const browser = await chromium.launch(executablePath ? { executablePath } : {})
  const context = await browser.newContext({
    ...device,
    recordVideo: video ? { dir: outDir, size: viewport } : undefined,
  })
  const page = await context.newPage()
  const videoHandle = video ? page.video() : null

  const consoleErrors = []
  let failedRequests = []
  const shots = []

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const at = msg.location?.() || {}
    consoleErrors.push({
      text: msg.text(),
      url: at.url || null,
      line: at.lineNumber ?? null,
    })
  })
  page.on('pageerror', (err) => {
    consoleErrors.push({ text: String(err), url: null, line: null })
  })
  // Context-level rather than page-level: requests the browser issues outside
  // the page's frame tree (favicons are the usual one) never reach the page
  // listeners, which is how a capture ended up reporting a console 404 with an
  // empty failedRequests list and no url to act on.
  context.on('requestfailed', (req) => {
    failedRequests.push({
      url: req.url(),
      error: req.failure()?.errorText ?? 'failed',
      resourceType: req.resourceType(),
    })
  })
  context.on('response', (res) => {
    if (res.status() >= 400) {
      failedRequests.push({
        url: res.url(),
        status: res.status(),
        resourceType: res.request().resourceType(),
      })
    }
  })

  const waitUntil = networkIdle ? 'networkidle' : 'load'
  let failure = null

  try {
    try {
      await page.goto(url, { waitUntil, timeout: timeoutMs })
    } catch (err) {
      throw new Error(
        `could not load ${url} within ${timeoutMs}ms (waiting for "${waitUntil}").`
        + `${summarise(consoleErrors, failedRequests)} Underlying error: ${err.message}`,
      )
    }

    if (waitFor) {
      try {
        await page.waitForSelector(waitFor, { state: 'visible', timeout: timeoutMs })
      } catch {
        throw new Error(
          `--wait-for selector ${JSON.stringify(waitFor)} never became visible on ${url} within ${timeoutMs}ms.`
          + summarise(consoleErrors, failedRequests),
        )
      }
    }

    if (waitMs > 0) await page.waitForTimeout(waitMs)

    if (typeof steps === 'function') await steps(page)

    const name = nextShotName(outDir)
    await page.screenshot({ path: join(outDir, name), fullPage })
    shots.push(name)
  } catch (err) {
    failure = err
  }

  await context.close()
  await browser.close()

  if (failure) {
    // The raw recording is only reachable through its Playwright-random name,
    // which no artifacts record will ever carry — remove it rather than
    // leaving an orphan in the gallery dir.
    if (videoHandle) {
      try {
        rmSync(await videoHandle.path(), { force: true })
      } catch {
        // The recording may not exist at all if the failure was early.
      }
    }
    throw failure
  }

  let videoName = null
  if (videoHandle) {
    const produced = await videoHandle.path()
    const target = join(outDir, nextVideoName(outDir))
    convertVideoToMp4(produced, target)
    rmSync(produced, { force: true })
    videoName = basename(target)
  }

  const correlated = correlateResourceErrors({ consoleErrors, failedRequests })
  failedRequests = dedupeRequests(correlated.failedRequests)
    .map((f) => ({ ...f, severity: classifySeverity(f.url) }))

  return {
    shots,
    video: videoName,
    consoleErrors: correlated.consoleErrors,
    failedRequests,
  }
}
