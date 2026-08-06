import { runDaemon } from './daemon.js'

// A single JSON argument rather than positionals: the option set grows, and
// silently shifting positionals is the kind of bug that only shows up on a
// phone twenty minutes into a session.
const opts = JSON.parse(process.argv[2])

try {
  await runDaemon(opts)
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
