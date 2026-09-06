/**
 * The self-API loopback listener and the public remote-access listener must
 * never accept each other's credential — they are independent modules with
 * independent in-memory state so that guarantee is structural, not just a
 * convention. This locks both directions down explicitly.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { validateToken, setCustomAccessToken, clearAccessToken } from '../../../../src/main/http/auth/token-store'
import { issueSelfApiToken, resolveSelfApiToken, resetSelfApiTokens } from '../../../../src/main/http/self-api/token-store'

const REMOTE_ACCESS_TOKEN = 'Aa1!Aa1!'
const SPACE_ID = 'space-1'

describe('self-API / remote-access token isolation', () => {
  beforeEach(() => {
    clearAccessToken()
    resetSelfApiTokens()
  })

  it('rejects the self-API token on the public remote-access listener', () => {
    setCustomAccessToken(REMOTE_ACCESS_TOKEN)
    const selfToken = issueSelfApiToken(SPACE_ID)

    expect(validateToken(selfToken)).toBe(false)
    expect(validateToken(REMOTE_ACCESS_TOKEN)).toBe(true)
  })

  it('rejects the remote-access token on the self-API loopback listener', () => {
    setCustomAccessToken(REMOTE_ACCESS_TOKEN)
    const selfToken = issueSelfApiToken(SPACE_ID)

    expect(resolveSelfApiToken(REMOTE_ACCESS_TOKEN)).toBeNull()
    expect(resolveSelfApiToken(selfToken)).toEqual({ spaceId: SPACE_ID })
  })
})
