import { existsSync, readdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

// Shared by capture.js (which actually launches a browser) and doctor.js
// (which only reports whether one is installed). Kept in its own module so the
// prerequisite check never has to import playwright — a broken playwright
// install is one of the things `mp doctor` exists to diagnose, and a check
// that crashes on the thing it is checking is worse than no check.

const CHROME_CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
}

export function findBrowserExecutable() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  if (explicit && existsSync(explicit)) return explicit

  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN

  const candidates = CHROME_CANDIDATES[platform()] || []
  return candidates.find((candidate) => existsSync(candidate)) || null
}

export function playwrightBrowsersDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH

  const home = homedir()
  if (platform() === 'win32') return join(home, 'AppData', 'Local', 'ms-playwright')
  if (platform() === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright')
  return join(home, '.cache', 'ms-playwright')
}

// The directory playwright unpacked chromium into, or null. Matching by prefix
// rather than by an exact revision: the revision changes with every playwright
// bump and a hard-coded one would report "missing" on a perfectly good install.
export function findPlaywrightChromium() {
  const dir = playwrightBrowsersDir()
  if (!existsSync(dir)) return null

  try {
    const match = readdirSync(dir).find((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
    return match ? join(dir, match) : null
  } catch {
    return null
  }
}
