// Reading the hook's payload, with a deadline.
//
// A hook that reads stdin is trusting the host to close it. Both of ours do,
// and `spawnSync` with no input does too — but a host that ever hands over an
// inherited terminal instead would leave the read pending until the timeout in
// hooks.json killed the process, and the hook would look like it does nothing.
// That failure is invisible: no error, no output, the feature simply stops.
//
// So the read is bounded, and running out of time is treated exactly like
// running out of input. Every caller here already does something sensible with
// a payload it could not parse.

const DEFAULT_MS = 2_000

export function readPayload(stream = process.stdin, timeoutMs = DEFAULT_MS) {
  return new Promise((resolve) => {
    let text = ''
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', finish)
      stream.removeListener('error', finish)
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(null)
      }
    }
    const onData = (chunk) => {
      text += chunk
      // Nothing a host sends is this big, and a stream that never ends must
      // not be able to grow this process instead of stalling it.
      if (text.length > 4_000_000) finish()
    }

    // Not unref'd: an unref'd timer never fires when the stream it is racing
    // is the only thing keeping the loop alive, which is exactly the case it
    // exists for. It is cleared as soon as the input ends, so a well-behaved
    // host never waits for it.
    const timer = setTimeout(finish, timeoutMs)
    stream.setEncoding('utf8')
    stream.on('data', onData)
    stream.once('end', finish)
    stream.once('error', finish)
  })
}
