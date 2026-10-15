/**
 * In-memory sliding-window limit per key (here: per signed-in user). Enough for a single-process demo
 * so a public deployment with a real API key cannot be looped into a large bill; a multi-instance
 * deployment needs a shared store instead.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Records a hit and returns true if it is within the limit. */
  take(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > nowMs - this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(nowMs)
    this.hits.set(key, recent)
    return true
  }
}

const perMinute = Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE ?? 20)
export const chatLimiter = new RateLimiter(Number.isFinite(perMinute) && perMinute > 0 ? perMinute : 20, 60_000)
