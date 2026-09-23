import { createReadStream, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import {
  basename, dirname, resolve, sep,
} from 'node:path'

// The missing half of "show me this page on my phone".
//
// Until 2026-09-22 the only way to preview a plain HTML file was for the agent
// to start a static server of its own — detached, so the harness would not
// track it — and nothing ever stopped it again. Seven of them were found
// listening on this machine, the oldest three days old. The cost was never
// memory: it was the port. A later preview pointed at that port proxied the
// page a previous task had left there, and the user opened a link that showed
// them the wrong thing entirely. (the user, 2026-09-22)
//
// So mp serves the file itself. The server lives inside the daemon process,
// which already dies on its TTL — one lifetime, not two, and nothing left
// behind to collide with.

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
}

function typeOf(p) {
  const i = p.lastIndexOf('.')
  return (i < 0 ? null : TYPES[p.slice(i).toLowerCase()]) || 'application/octet-stream'
}

// What `--serve <path>` means, decided once here rather than in the CLI and
// again in the daemon. A directory is served whole; a single file is served
// *alone* — not its directory — because `--serve ./docs/report.html` must not
// put the rest of ./docs on a public url. A page that needs siblings gets
// pointed at the directory on purpose.
export function resolveServeTarget(path) {
  const full = resolve(path)
  let st
  try {
    st = statSync(full)
  } catch {
    throw new Error(`--serve ${path}: no such file or directory`)
  }
  if (st.isDirectory()) return { root: realpathSync(full), file: null }
  if (!st.isFile()) throw new Error(`--serve ${path}: not a file or directory`)
  return { root: realpathSync(dirname(full)), file: basename(full) }
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

// Everything the proxy in front of this already refuses — a wrong token, an
// expired preview — never gets here. What is left to defend against is a path
// that climbs out of the root, so containment is checked on the *resolved*
// path, and again through realpath so a symlink inside the root cannot point
// out of it.
function within(root, full) {
  return full === root || full.startsWith(root + sep)
}

export function createStaticServer({ root, file = null }) {
  return createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' })
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch {
      return send(res, 400, 'bad request')
    }

    // Single-file mode: the one file, at `/` or under its own name, and
    // nothing else exists.
    if (file) {
      if (pathname !== '/' && pathname !== `/${file}`) return send(res, 404, 'not found')
      // The one file the user named, symlink or not: naming it was the choice.
      return serveFile(res, resolve(root, file), req.method, null)
    }

    const full = resolve(root, `.${pathname}`)
    if (!within(root, full)) return send(res, 404, 'not found')

    let st = null
    try {
      st = statSync(full)
    } catch {
      return send(res, 404, 'not found')
    }

    if (st.isDirectory()) {
      // `/docs` must become `/docs/` before its index is served, or every
      // relative url in the page resolves against the parent directory and the
      // page arrives without its styles and scripts. Relative Location, so
      // whatever prefix the proxy in front adds stays out of it.
      if (!pathname.endsWith('/')) {
        const u = new URL(req.url, 'http://localhost')
        const last = u.pathname.slice(u.pathname.lastIndexOf('/') + 1)
        return send(res, 301, 'moved', { Location: `${last}/${u.search}` })
      }
      const index = resolve(full, 'index.html')
      try {
        if (!statSync(index).isFile()) throw new Error('not a file')
      } catch {
        return send(res, 404, `no index.html in ${pathname}`)
      }
      return serveFile(res, index, req.method, root)
    }
    return serveFile(res, full, req.method, root)
  })
}

// `root` set: the resolved file must still be inside it, so a symlink in the
// served directory cannot hand out ~/.ssh over the tunnel.
function serveFile(res, full, method, root) {
  let real
  let st
  try {
    real = realpathSync(full)
    st = statSync(real)
  } catch {
    return send(res, 404, 'not found')
  }
  if (root && !within(root, real)) return send(res, 404, 'not found')
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': typeOf(real),
    'Content-Length': st.size,
  }
  if (method === 'HEAD') {
    res.writeHead(200, headers)
    return res.end()
  }
  res.writeHead(200, headers)
  const stream = createReadStream(real)
  // A read that dies half-way cannot be turned into a status code — the
  // headers are already out — so drop the connection instead of leaving the
  // phone waiting on a body that will never finish.
  stream.on('error', () => res.destroy())
  return stream.pipe(res)
}
