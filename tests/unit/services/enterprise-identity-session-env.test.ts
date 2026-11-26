import { describe, expect, it } from 'vitest'
import { sanitizeSessionEnvironment } from '../../../src/main/services/enterprise-identity/service'
import { computeCredentialsFingerprint } from '../../../src/main/services/agent/sdk-config'

describe('organization session environment', () => {
  it('keeps well-formed variables and drops reserved, malformed or oversized ones', () => {
    expect(sanitizeSessionEnvironment({
      ORG_ACCESS_COMMAND: '["/app/runtime","/app/broker.cjs"]',
      PATH: '/evil',
      NODE_OPTIONS: '--require x',
      HALO_CLI_TOOLS_BIN: '/x',
      'BAD NAME': 'x',
      MULTI: 'a\nb',
      EMPTY: '',
      HUGE: 'x'.repeat(5000),
      NUM: 3,
    })).toEqual({ ORG_ACCESS_COMMAND: '["/app/runtime","/app/broker.cjs"]' })
    expect(sanitizeSessionEnvironment(null)).toEqual({})
    expect(sanitizeSessionEnvironment(['x'])).toEqual({})
  })

  it('changes the session fingerprint when the variables change, and only then', () => {
    const base = { env: { PATH: '/bin' }, model: 'm' }
    const without = computeCredentialsFingerprint(base)
    expect(computeCredentialsFingerprint({ ...base })).toBe(without)
    const signedIn = computeCredentialsFingerprint({ ...base, orgSessionEnv: 'abc' })
    expect(signedIn).not.toBe(without)
    expect(computeCredentialsFingerprint({ ...base, orgSessionEnv: 'def' })).not.toBe(signedIn)
  })
})
