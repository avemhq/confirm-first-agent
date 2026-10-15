/** Injectable time source so expiry and "overdue" logic are testable. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

export class FixedClock implements Clock {
  private t: number
  constructor(iso: string) {
    this.t = Date.parse(iso)
  }
  now(): Date {
    return new Date(this.t)
  }
  advance(seconds: number): void {
    this.t += seconds * 1000
  }
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10)
export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000)
