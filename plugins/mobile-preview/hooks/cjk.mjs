// How much there is to read, in one unit that means the same thing in either
// language.
//
// Han, kana and the full-width punctuation that comes with them, weighted so
// that one threshold covers both. Counting raw characters would make every
// Chinese message look trivial beside the English one saying the same thing —
// the same sentence runs about 26 characters in Chinese and 123 in English —
// and any threshold built on raw characters is effectively not installed for a
// Chinese-speaking user. Three is the ratio by reading time, not by character
// count.
//
// Shared because it was not, once: 0.5.0 weighted the question tool's
// thresholds and left the Stop hook counting raw characters, so on this
// machine — where the questions are written in Chinese — the one trigger that
// still works on Codex needed a message three times longer than intended
// before it would fire.

export const CJK_WEIGHT = 3
export const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/

export function weigh(text) {
  let n = 0
  for (const c of String(text ?? '')) n += CJK.test(c) ? CJK_WEIGHT : 1
  return n
}
