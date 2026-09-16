import { readFileSync, rmSync } from 'node:fs'
import { runInteractionDaemon } from './interaction-daemon.js'

try {
  // One JSON argument, same as daemon-entry.js and secret-daemon-entry.js —
  // but the page travels as a path, not inside it. Windows caps a command
  // line at ~32 KB and a page may be ten times that, so `mp interaction ask`
  // stages a copy in the state dir and hands over its name. The copy is read
  // once and deleted: from here on the page lives in this process.
  const { htmlPath, ...opts } = JSON.parse(process.argv[2])
  if (htmlPath) {
    opts.html = readFileSync(htmlPath, 'utf8')
    rmSync(htmlPath, { force: true })
  }
  await runInteractionDaemon(opts)
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
