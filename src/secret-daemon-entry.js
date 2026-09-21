import { runSecretDaemon } from './secret-daemon.js'
import { platformKeystore } from './keystore.js'
import { createVault } from './secret-vault.js'

try {
  // One JSON argument, same as daemon-entry.js and for the same reason.
  const opts = JSON.parse(process.argv[2])
  // The keystore is chosen here and nowhere else: no option, no environment
  // variable can hand the daemon one that keeps the vault key in the clear.
  const vault = opts.projectRoot ? createVault({ keystore: platformKeystore() }) : null
  await runSecretDaemon({ ...opts, vault })
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
