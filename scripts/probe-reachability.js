import { createServer } from 'node:http'
import { startTunnel, killTree } from '../src/tunnel.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAABQCAIAAAA5Z4dJAAAAT0lEQVR4nO3BMQEAAADCoPVP' +
  'bQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAADgbxIAAAHqYlPKAAAAAElFTkSuQmCC',
  'base64',
)

const server = createServer((req, res) => {
  if (req.url.startsWith('/probe.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(PNG)
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<h1 style="font:700 64px sans-serif">REACHABILITY OK</h1>')
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  console.log(`local server on ${port}`)
  try {
    const { url, pid } = await startTunnel(port)
    console.log('')
    console.log(`  tunnel: ${url}`)
    console.log('  paste this line into the chat reply:')
    console.log('')
    console.log(`  ![probe](${url}/probe.png)`)
    console.log('')
    console.log('  press Ctrl+C to tear down')
    process.on('SIGINT', () => {
      killTree(pid)
      server.close()
      process.exit(0)
    })
    process.on('SIGTERM', () => {
      killTree(pid)
      server.close()
      process.exit(0)
    })
  } catch (err) {
    console.error(err?.message || String(err))
    server.close()
    process.exit(1)
  }
})
