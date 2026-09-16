import { createConnection } from 'node:net'

// The CLI's side of the daemon's IPC. One request per connection, newline-
// delimited JSON both ways; the daemon answers with a stream of events that
// ends in exactly one of `exit`, `status`, `ok` or `error`.

export const TERMINAL_EVENTS = new Set(['exit', 'status', 'ok', 'error'])

export function secretCall(ipcPath, request, { onEvent = null, connectTimeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let buf = ''
    const finish = (fn, v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(v)
    }

    const sock = createConnection(ipcPath)
    const timer = setTimeout(() => {
      sock.destroy()
      finish(reject, new Error(`timed out connecting to the secret daemon at ${ipcPath}`))
    }, connectTimeoutMs)

    sock.setEncoding('utf8')
    sock.on('connect', () => {
      clearTimeout(timer)
      sock.write(`${JSON.stringify(request)}\n`)
    })
    sock.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (TERMINAL_EVENTS.has(ev.type)) {
          finish(resolve, ev)
          sock.end()
          return
        }
        try {
          onEvent?.(ev)
        } catch {
          // A rendering problem on our side must not break the run.
        }
      }
    })
    sock.on('error', (err) => finish(reject, err))
    sock.on('close', () => finish(reject, new Error('the secret daemon closed the connection without answering')))
  })
}
