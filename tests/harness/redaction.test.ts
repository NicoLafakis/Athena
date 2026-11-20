import { describe, expect, it } from 'vitest'
import { containsSecret, redactSessionValue } from '../../src/harness/redaction.js'
import { sensitiveText } from '../../src/library/config.js'
import { safeText } from '../../src/journal/sources.js'

describe('shared boundary redaction', () => {
  const PEM =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----'
  const GHP = ['ghp', '1234567890abcdefghij1234567890abcd'].join('_')
  const GHPAT = ['github', 'pat', '11ABCDEFG0123456789', 'abcdefghijklmnop'].join('_')
  const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE'
  const BEARER = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
  const SLACK = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnopqrstuvwx'].join('-')
  const STRIPE_SK = ['sk', 'live', '51H7abc1234567890DEFGHIJKLMN'].join('_')
  const STRIPE_RK = ['rk', 'test', '51H7abc1234567890DEFGHIJKLMN'].join('_')
  const LEGACY_SK = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')
  const INLINE_PW = 'password=super-secret-value-99'

  it('redacts PEM blocks, GitHub tokens, AWS keys, Bearer, Slack, Stripe, provider keys, and inline secrets', () => {
    for (const secret of [PEM, GHP, GHPAT, AWS, SLACK, STRIPE_SK, STRIPE_RK, LEGACY_SK]) {
      const redacted = redactSessionValue(`prefix ${secret} suffix`) as string
      expect(redacted).not.toContain(secret)
      expect(redacted).toContain('[REDACTED]')
      expect(containsSecret(secret)).toBe(true)
      expect(containsSecret(redacted)).toBe(false)
    }

    const bearerRedacted = redactSessionValue(`Authorization: ${BEARER}`) as string
    expect(bearerRedacted).toContain('Bearer [REDACTED]')
    expect(bearerRedacted).not.toContain('eyJhbGci')
    expect(containsSecret(BEARER)).toBe(true)

    const inlineRedacted = redactSessionValue(`config ${INLINE_PW} done`) as string
    expect(inlineRedacted).not.toContain('super-secret-value-99')
    expect(inlineRedacted).toContain('[REDACTED]')
    expect(containsSecret(INLINE_PW)).toBe(true)
    // Idempotency: already-redacted text must not re-trigger containsSecret.
    expect(containsSecret(inlineRedacted)).toBe(false)
  })

  it('does not flag ordinary prose as secrets', () => {
    const clean = 'Use pnpm test to verify the TypeScript build before committing.'
    expect(containsSecret(clean)).toBe(false)
    expect(redactSessionValue(clean)).toBe(clean)
  })

  it('composes into library sensitiveText and journal safeText', () => {
    expect(sensitiveText(`token: ${GHPAT}`)).toBe(true)
    expect(sensitiveText(`key: ${SLACK}`)).toBe(true)
    expect(sensitiveText('email: alice@example.com')).toBe(true)

    expect(safeText(`leaked ${GHP}`)).toBe('leaked [REDACTED]')
    expect(safeText(`leaked ${SLACK}`)).toBe('leaked [REDACTED]')
    expect(safeText(`leaked ${PEM}`)).toBeNull()
    expect(safeText('email alice@example.com')).toBeNull()
    expect(safeText('normal project observation')).toBe('normal project observation')
  })
})
