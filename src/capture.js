import { chromium, devices } from 'playwright'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { platform } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

function findBrowserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  }

  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN

  if (platform() === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
  }

  return null
}

function findCommand(command) {
  const locator = platform() === 'win32' ? 'where' : 'which'
  try {
    const out = execFileSync(locator, [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const first = out.split(/\r?\n/).find(Boolean)
    return first ? first.trim() : null
  } catch {
    return null
  }
}

function convertVideoToMp4(input, output) {
  const ffmpeg = findCommand('ffmpeg')
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
  ], { encoding: 'utf8' })

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`
    throw new Error(`ffmpeg failed to convert video: ${detail}`)
  }
}

export async function capture({
  url,
  outDir,
  steps = null,
  video = false,
  deviceName = 'iPhone 13',
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
  const failedRequests = []
  const shots = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(String(err))
  })
  page.on('requestfailed', (req) => {
    failedRequests.push({
      url: req.url(),
      error: req.failure()?.errorText ?? 'failed',
    })
  })
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push({ url: res.url(), status: res.status() })
  })

  let failure = null
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
    await page.waitForTimeout(500)

    if (typeof steps === 'function') await steps(page)

    const name = 'shot-1.png'
    await page.screenshot({ path: join(outDir, name), fullPage: false })
    shots.push(name)
  } catch (err) {
    failure = err
  }

  await context.close()
  await browser.close()

  if (failure) throw failure

  let videoName = null
  if (videoHandle) {
    const produced = await videoHandle.path()
    const target = join(outDir, 'reel.mp4')
    convertVideoToMp4(produced, target)
    rmSync(produced, { force: true })
    videoName = basename(target)
  }

  return { shots, video: videoName, consoleErrors, failedRequests }
}
