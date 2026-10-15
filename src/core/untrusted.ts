/**
 * Free text from the database is DATA. It reaches the model wrapped in a tag the model is told
 * never to obey. The content is JSON-escaped and '<' / '>' are escaped as well, so a stored string
 * cannot close the tag early or open a fake one.
 */
export function wrapUntrusted(source: string, text: string): string {
  const safeSource = source.replace(/[^A-Za-z0-9:_-]/g, '')
  const body = JSON.stringify(text).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  return `<untrusted_data source="${safeSource}">${body}</untrusted_data>`
}

/**
 * Short stored strings (titles, names) are not wrapped, to keep tool results readable,
 * but angle brackets are escaped so they cannot open or close a tag in the model context.
 */
export function escapeTags(text: string): string {
  return text.replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above)\s+instructions/i,
  /system\s+(note|prompt|message)\s*:/i,
  /\bdelete\s+(all|every)\b/i,
  /\byou\s+are\s+now\b/i,
  /\bdisregard\s+(all|your|the)\b/i,
]

/**
 * Heuristic only. It flags obvious attempts for the audit log and the UI badge.
 * It is NOT the defence: the defence is structural (no delete tool, no confirm tool,
 * server-side permissions, token only in the human's browser).
 */
export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text))
}

/**
 * C0/C1 control characters, line/paragraph separators and Unicode bidi overrides. In a terminal they
 * can hide or recolour text (ESC[8m), rewrite a line (CR) or reorder it visually (U+202E), so a
 * confirmation prompt could show something other than what will be applied.
 */
// Built from code points (not escapes in a literal) so editors and formatters cannot turn them into
// invisible characters in this file.
const ranges: [number, number][] = [
  [0x00, 0x1f], // C0 controls, including ESC, CR, LF, TAB
  [0x7f, 0x9f], // DEL and C1 controls
  [0x061c, 0x061c], // Arabic letter mark
  [0x200e, 0x200f], // LRM, RLM
  [0x2028, 0x2029], // line and paragraph separator
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2066, 0x2069], // bidi isolates
]
const hex = (n: number) => `\\u${n.toString(16).padStart(4, '0')}`
const CLASS = `[${ranges.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')}]`
const UNSAFE = new RegExp(CLASS)

/** One-line fields (titles, reasons): no control or bidi characters at all. */
export const isSafeLine = (s: string): boolean => !UNSAFE.test(s)

/** Multi-line fields (descriptions, report bodies): newline and tab are fine, nothing else. */
export const isSafeText = (s: string): boolean => !UNSAFE.test(s.replace(/[\n\t]/g, ''))

const UNSAFE_OR_BACKSLASH = new RegExp(`\\\\|${CLASS}`, 'g')

/**
 * For confirmation screens: every control or bidi character becomes a visible \u{..} escape, and a
 * literal backslash becomes \\, so the display is unambiguous: a real line break and the six typed
 * characters \u{a} never look the same. `multiline` keeps newline and tab as they are (for
 * descriptions and report bodies shown as text). Apply once, at the display boundary.
 */
export const visible = (s: string, multiline = false): string =>
  s.replace(UNSAFE_OR_BACKSLASH, (c) =>
    c === '\\' ? '\\\\' : multiline && (c === '\n' || c === '\t') ? c : `\\u{${c.codePointAt(0)!.toString(16)}}`,
  )
