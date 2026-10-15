import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Pure parts of the demo session (no Next.js imports, so they are unit-testable).
 * Cookie value: `<userId>.<expiresAtUnixSeconds>.<HMAC(secret, "session:<userId>:<exp>")>`.
 * The expiry is inside the signature, so a copied cookie stops working server-side after SESSION_SECONDS,
 * independent of what the browser does with Max-Age.
 */
export const SESSION_SECONDS = 60 * 60 * 8

const sign = (secret: Buffer, userId: string, exp: number) =>
  createHmac('sha256', secret).update(`session:${userId}:${exp}`).digest('base64url')

export function signSession(secret: Buffer, userId: string, nowSeconds: number): string {
  const exp = nowSeconds + SESSION_SECONDS
  return `${userId}.${exp}.${sign(secret, userId, exp)}`
}

/** Returns the user id if the cookie is well-formed, correctly signed and not expired. */
export function verifySession(secret: Buffer, raw: string | undefined, nowSeconds: number): string | null {
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const [userId, expRaw, sig] = parts as [string, string, string]
  if (!/^[a-z]{1,20}$/.test(userId) || !/^\d{1,12}$/.test(expRaw) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null
  const exp = Number(expRaw)
  const a = Buffer.from(sig)
  const b = Buffer.from(sign(secret, userId, exp))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return exp > nowSeconds ? userId : null
}

/**
 * CSRF defence for state-changing routes: the Origin header must match the Host.
 * X-Forwarded-Host is only honoured behind a proxy you control (TRUST_PROXY=1); otherwise any client
 * could pick the host it is compared against.
 */
export function sameOriginHeaders(headers: Headers, trustProxy: boolean): boolean {
  const origin = headers.get('origin')
  const host = (trustProxy ? headers.get('x-forwarded-host') : null) ?? headers.get('host')
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
