import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { get } from '@/core/db'
import { getCore } from '@/core/runtime'

/**
 * Demo sign-in: a user switcher backed by an HMAC-signed, httpOnly, SameSite=Strict cookie.
 * Not a real login (see README, Limitations). The point: the actor always comes from here,
 * never from anything the model writes.
 */
const COOKIE = 'cfa_session'

const mac = (userId: string) => createHmac('sha256', getCore().secret).update(`session:${userId}`).digest('base64url')

export function userExists(userId: string): boolean {
  return /^[a-z]{1,20}$/.test(userId) && !!get(getCore().db, 'SELECT 1 FROM users WHERE id = ?', userId)
}

export async function sessionUser(): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value
  if (!raw) return null
  const [userId, sig] = raw.split('.')
  if (!userId || !sig) return null
  const a = Buffer.from(sig)
  const b = Buffer.from(mac(userId))
  if (a.length !== b.length || !timingSafeEqual(a, b) || !userExists(userId)) return null
  return userId
}

export async function setSessionUser(userId: string): Promise<void> {
  ;(await cookies()).set(COOKIE, `${userId}.${mac(userId)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 8,
  })
}

/** CSRF defence for state-changing routes: the Origin header must match the Host. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
