import { createHash } from 'node:crypto'

/** JSON with recursively sorted object keys: same value, same bytes, same hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortDeep(x)
    }
    return out
  }
  return v
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
