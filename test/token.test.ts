import { describe, expect, it } from 'vitest'
import { signToken, verifyToken, type TokenPayload } from '@/core/proposals'

const secret = Buffer.from('k'.repeat(32))
const payload: TokenPayload = { pid: 'P-1', sub: 'bob', ah: 'a'.repeat(64), bv: 3, exp: 2_000_000_000 }

describe('confirmation token', () => {
  it('round-trips a valid token', () => {
    const v = verifyToken(secret, signToken(secret, payload))
    expect(v).toEqual({ ok: true, payload })
  })

  it('rejects a token signed with another secret', () => {
    const v = verifyToken(secret, signToken(Buffer.from('z'.repeat(32)), payload))
    expect(v).toMatchObject({ ok: false, reason: 'bad_signature' })
  })

  it('rejects any tampered part', () => {
    const t = signToken(secret, payload)
    const [v1, body, mac] = t.split('.') as [string, string, string]
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, sub: 'alice' })).toString('base64url')
    expect(verifyToken(secret, `${v1}.${forgedBody}.${mac}`).ok).toBe(false)
    expect(verifyToken(secret, `v2.${body}.${mac}`).ok).toBe(false)
    const flipped = mac.slice(0, -2) + (mac.endsWith('AA') ? 'BB' : 'AA')
    expect(verifyToken(secret, `${v1}.${body}.${flipped}`).ok).toBe(false)
  })

  it('handles MACs of the wrong length without throwing', () => {
    const [v1, body] = signToken(secret, payload).split('.') as [string, string]
    expect(verifyToken(secret, `${v1}.${body}.abc`)).toMatchObject({ ok: false, reason: 'bad_signature' })
    expect(verifyToken(secret, `${v1}.${body}.`)).toMatchObject({ ok: false })
  })

  it('rejects missing and malformed input', () => {
    for (const bad of [undefined, null, 42, '', 'a.b', 'a.b.c.d', 'x'.repeat(5000)]) {
      expect(verifyToken(secret, bad).ok).toBe(false)
    }
  })
})
