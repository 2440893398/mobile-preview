import { runDaemon } from './daemon.js'

try {
  // A single JSON argument rather than positionals: the option set grows, and
  // silently shifting positionals is the kind of bug that only shows up on a
  // phone twenty minutes into a session. Parsed inside the try so a malformed
  // argument produces the same one-line message as any other startup failure
  // rather than a raw SyntaxError and stack trace.
  const opts = JSON.parse(process.argv[2])
  await runDaemon(opts)
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
