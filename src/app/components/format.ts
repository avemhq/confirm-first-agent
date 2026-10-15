/**
 * One diff cell on the confirmation card. Text is always shown in quotes and an absent value as
 * (none) without quotes, so no text, not even "(none)" or "", can look like another value.
 * Numbers and booleans appear bare, objects as JSON. The strings arrive already escaped by toView.
 */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '(none)'
  if (typeof v === 'string') return `"${v}"`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}
