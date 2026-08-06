#!/usr/bin/env node
import { main } from './cli.js'

try {
  await main(process.argv.slice(2))
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
