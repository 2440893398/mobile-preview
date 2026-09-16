// Replaces secret values — and the forms they most often take when a program
// prints them — in a stream of text. This is the defence against a value
// being printed by accident; it is not, and cannot be, a defence against a
// process that transforms a value before printing it (design §5.3, §7).

// A line of a multi-line value has to clear this before it becomes a pattern
// of its own: a PEM body line is worth matching, a line containing `x` is not,
// because it would redact every x in the output.
const MIN_LINE_LEN = 8
// An *encoded* form has to clear this. The bar is low on purpose: base64 is a
// distinctive shape, so a short one costs at most a spurious [REDACTED:…] in
// some unrelated output, while leaving it out costs the value itself.
const MIN_VARIANT_LEN = 4

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The raw value first, then each line of a multi-line value (a PEM key is
// printed line by line, never as one string), then the four encodings a value
// commonly picks up on its way to a terminal: base64, base64url, URL escaping
// and JSON escaping.
//
// The length test applies to the encoding, never to the input. Testing the
// input is what let a live run print `base64=Y2VzdA==` next to a correctly
// redacted 4-character value — the redaction held and the encoding beside it
// gave the value away (2026-09-11 phone trial, design §12). A short input has
// a short encoding only when the encoding is the input, and that case is
// already covered by the raw form.
export function variantsOf(value) {
  const v = String(value ?? '')
  if (!v) return []

  const out = new Set([v])
  for (const line of v.split(/\r?\n/)) {
    const t = line.trim()
    if (t.length >= MIN_LINE_LEN) out.add(t)
  }

  const buf = Buffer.from(v, 'utf8')
  const encodings = [
    buf.toString('base64'),
    buf.toString('base64url'),
    encodeURIComponent(v),
    JSON.stringify(v).slice(1, -1),
  ]
  for (const encoded of encodings) {
    // An encoding identical to the value adds nothing — an alphanumeric value
    // URL-encodes and JSON-escapes to itself.
    if (encoded !== v && encoded.length >= MIN_VARIANT_LEN) out.add(encoded)
  }
  return [...out].filter(Boolean)
}

// `secrets` is [{ name, value }]. Longer patterns are tried first so a value
// that is a prefix of another's encoding is not half-replaced.
export function createScrubber(secrets) {
  const patterns = []
  for (const { name, value } of secrets) {
    for (const p of variantsOf(value)) patterns.push({ p, name })
  }
  patterns.sort((a, b) => b.p.length - a.p.length)

  const maxLen = patterns.reduce((m, x) => Math.max(m, x.p.length), 0)
  const byPattern = new Map(patterns.map((x) => [x.p, x.name]))
  const re = patterns.length ? new RegExp(patterns.map((x) => escapeRe(x.p)).join('|'), 'g') : null
  const replace = (text) => (re ? text.replace(re, (m) => `[REDACTED:${byPattern.get(m)}]`) : text)

  // A value can straddle two chunks. After scrubbing, the last maxLen-1
  // characters are held back: any occurrence that continues into the next
  // chunk has at most that many characters in this one, so it is still whole
  // when the next chunk arrives. What is held back is already-scrubbed text,
  // so re-scanning it is harmless.
  const keep = Math.max(0, maxLen - 1)
  let tail = ''

  return {
    push(chunk) {
      const s = replace(tail + String(chunk))
      if (s.length <= keep) {
        tail = s
        return ''
      }
      tail = s.slice(s.length - keep)
      return s.slice(0, s.length - keep)
    },
    flush() {
      const s = replace(tail)
      tail = ''
      return s
    },
  }
}

export function scrubText(text, secrets) {
  const s = createScrubber(secrets)
  return s.push(text) + s.flush()
}
