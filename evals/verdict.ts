/** A scenario with fewer checks proves too little to count as a pass (an empty list is not a PASS). */
export const MIN_CHECKS = 2

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

/** Turns the checks of one scenario into a table cell and, on failure, a detail line. */
export function verdict(res: Check[]): { pass: boolean; result: string; detail: string } {
  if (res.length < MIN_CHECKS) {
    return { pass: false, result: `FAIL (${res.length} checks, minimum ${MIN_CHECKS})`, detail: 'too few checks to prove anything' }
  }
  const bad = res.filter((c) => !c.ok)
  if (bad.length) {
    return {
      pass: false,
      result: `FAIL (${res.length - bad.length}/${res.length})`,
      detail: bad.map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ''}`).join(' | '),
    }
  }
  return { pass: true, result: `PASS (${res.length}/${res.length})`, detail: '' }
}
