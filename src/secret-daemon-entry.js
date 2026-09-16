import { runSecretDaemon } from './secret-daemon.js'

try {
  // One JSON argument, same as daemon-entry.js and for the same reason.
  const opts = JSON.parse(process.argv[2])
  await runSecretDaemon(opts)
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
