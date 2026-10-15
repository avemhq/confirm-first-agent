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
