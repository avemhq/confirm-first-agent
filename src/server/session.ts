import { cookies } from 'next/headers'
import { get } from '@/core/db'
import { getCore } from '@/core/runtime'
import { sameOriginHeaders, SESSION_SECONDS, signSession, verifySession } from './session-core'

/**
 * Demo sign-in: a user switcher backed by an HMAC-signed, expiring, httpOnly, SameSite=Strict cookie.
 * Not a real login (see README, Limitations). The point: the actor always comes from here,
 * never from anything the model writes.
 */
const COOKIE = 'cfa_session'
const nowSeconds = () => Math.floor(Date.now() / 1000)

export function userExists(userId: string): boolean {
  return /^[a-z]{1,20}$/.test(userId) && !!get(getCore().db, 'SELECT 1 FROM users WHERE id = ?', userId)
}

export async function sessionUser(): Promise<string | null> {
  const userId = verifySession(getCore().secret, (await cookies()).get(COOKIE)?.value, nowSeconds())
  return userId && userExists(userId) ? userId : null
}

export async function setSessionUser(userId: string): Promise<void> {
  ;(await cookies()).set(COOKIE, signSession(getCore().secret, userId, nowSeconds()), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_SECONDS,
  })
}

export const sameOrigin = (req: Request): boolean => sameOriginHeaders(req.headers, process.env.TRUST_PROXY === '1')

export const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
