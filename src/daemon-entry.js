import { runDaemon } from './daemon.js'

const [port, dev, ttl, galleryDir] = process.argv.slice(2)

try {
  await runDaemon({
    targetPort: Number(port),
    dev: dev === 'true',
    ttlMinutes: Number(ttl),
    galleryDir,
  })
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
