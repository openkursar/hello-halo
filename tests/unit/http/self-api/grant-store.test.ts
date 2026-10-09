import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  issueSelfApiGrant,
  resolveSelfApiGrant,
  resetSelfApiGrants,
  type SelfApiGrantRequest,
} from '../../../../src/main/http/self-api/grant-store'
import { issueSelfApiToken, resolveSelfApiToken, resetSelfApiTokens } from '../../../../src/main/http/self-api/token-store'

const METHOD = 'POST'
const PATH = '/api/apps/app-1/escalation/entry-1/respond'
const TTL = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const request = { method: METHOD, path: PATH }

beforeEach(() => {
  resetSelfApiGrants()
  resetSelfApiTokens()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => { vi.restoreAllMocks() })

describe('temporary self-API grants', () => {
  it('issues independent random prefixed grants with a fixed 24-hour expiry', () => {
    const first = issueSelfApiGrant(request)
    const second = issueSelfApiGrant(request)
    expect(first.token).toMatch(/^halo-grant-[a-f0-9]{64}$/)
    expect(second.token).not.toBe(first.token)
    expect(first.expiresAt).toBe(NOW + TTL)
    expect(Object.keys(first).sort()).toEqual(['expiresAt', 'token'])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('is multi-use but expires at the exact boundary without renewing on use', () => {
    const grant = issueSelfApiGrant(request)
    for (const time of [NOW, NOW + 1, grant.expiresAt - 1]) {
      vi.mocked(Date.now).mockReturnValue(time)
      expect(resolveSelfApiGrant(grant.token, METHOD, PATH)).toEqual({ decision: 'allowed' })
    }
    vi.mocked(Date.now).mockReturnValue(grant.expiresAt)
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH)).toEqual({ decision: 'unavailable' })
    vi.mocked(Date.now).mockReturnValue(NOW)
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH)).toEqual({ decision: 'unavailable' })
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('loses old grants on reset and leaves regular tokens unchanged', () => {
    const regular = issueSelfApiToken('space-a')
    const grant = issueSelfApiGrant(request)
    expect(resolveSelfApiToken(grant.token)).toBe(false)
    expect(resolveSelfApiGrant(regular, METHOD, PATH).decision).toBe('unavailable')
    resetSelfApiGrants()
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('unavailable')
    expect(resolveSelfApiToken(regular)).toBe(true)
    expect(issueSelfApiToken('space-a')).toBe(regular)
    expect(resolveSelfApiGrant(issueSelfApiGrant(request).token, METHOD, PATH).decision).toBe('allowed')
  })

  it('does not persist grants across module reloads', async () => {
    const grant = issueSelfApiGrant(request)
    vi.resetModules()
    const restarted = await import('../../../../src/main/http/self-api/grant-store')
    expect(restarted.resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('unavailable')
  })

  it.each([
    ['GET', PATH],
    ['post', PATH],
    [METHOD, PATH + '/'],
    [METHOD, PATH + '/extra'],
    [METHOD, PATH.replace('entry-1', 'entry-2')],
    [METHOD, PATH.replace('app-1', 'app-2')],
    [METHOD, PATH.replace('/api/', '/apis/')],
    [METHOD, PATH.replace('respond', '%72espond')],
    [METHOD, PATH + '?other=1'],
    [METHOD, PATH + '#other'],
  ])('matches method and raw target literally: %s %s', (method, path) => {
    const validate = vi.fn(() => undefined)
    const grant = issueSelfApiGrant({ ...request, validate })
    expect(resolveSelfApiGrant(grant.token, method, path).decision).toBe('mismatch')
    expect(validate).not.toHaveBeenCalled()
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('allowed')
  })

  it('captures request fields instead of retaining a mutable request object', () => {
    const input: SelfApiGrantRequest = { ...request }
    const grant = issueSelfApiGrant(input)
    input.method = 'DELETE'
    input.path = '/api/apps/app-2'
    input.validate = () => 'changed'
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('allowed')
    expect(resolveSelfApiGrant(grant.token, input.method, input.path).decision).toBe('mismatch')
  })

  it('checks state on every use and cannot revive after a denial', () => {
    const validate = vi.fn<[], string | undefined>(() => undefined)
    const grant = issueSelfApiGrant({ ...request, validate })
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('allowed')
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('allowed')
    validate.mockReturnValue('The invited action is already closed.')
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH)).toEqual({
      decision: 'invalid', reason: 'The invited action is already closed.',
    })
    validate.mockReturnValue(undefined)
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('unavailable')
    expect(validate).toHaveBeenCalledTimes(3)
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('grant-validate'), { method: METHOD, path: PATH },
    )
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('already closed')
  })

  it('fails closed on a thrown validator, logs no error payload, and never retries it', () => {
    const validate = vi.fn(() => { throw new Error('private-action-payload') })
    const grant = issueSelfApiGrant({ ...request, validate })
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH)).toEqual({ decision: 'invalid' })
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('unavailable')
    expect(validate).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('grant-validate'), { method: METHOD, path: PATH },
    )
    const logs = JSON.stringify(vi.mocked(console.warn).mock.calls)
    expect(logs).not.toContain(grant.token)
    expect(logs).not.toContain('private-action-payload')
  })

  it.each(['', null, false, Promise.resolve(undefined)])('only undefined means valid, not %s', (reason) => {
    const validate = vi.fn(() => reason) as unknown as () => string | undefined
    const grant = issueSelfApiGrant({ ...request, validate })
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('invalid')
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('unavailable')
  })

  it('revokes an accidentally async validator without leaving an unhandled rejection', async () => {
    const validate = (async () => { throw new Error('private-async-payload') }) as unknown as () => string | undefined
    const grant = issueSelfApiGrant({ ...request, validate })
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('invalid')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('unavailable')
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-async-payload')
  })

  it('does not call state validation for an expired grant', () => {
    const validate = vi.fn(() => undefined)
    const grant = issueSelfApiGrant({ ...request, validate })
    vi.mocked(Date.now).mockReturnValue(grant.expiresAt)
    expect(resolveSelfApiGrant(grant.token, METHOD, PATH).decision).toBe('unavailable')
    expect(validate).not.toHaveBeenCalled()
  })
})

describe('literal grant issuance', () => {
  it.each(['', '*', 'post', ' POST', 'POST ', 'POST|GET', 'GET\n'])('rejects method %j', (method) => {
    expect(() => issueSelfApiGrant({ method, path: PATH })).toThrow()
  })

  it.each([
    '', '/', '/api', '/api/', '/apis/apps', '/API/apps', 'api/apps', 'https://localhost/api/apps',
    '/api/apps/*', '/api/apps/**', '/api/apps/:appId', '/api/apps/{id}', '/api/apps/(id)', '/api/apps/[id]',
    '/api/apps?spaceId=x', '/api/apps#fragment', '/api/apps/', '/api//apps', '//api/apps',
    '/api/./apps', '/api/apps/../config', '/api/apps/..', '/api/apps/a..b', '/api/apps\\config',
    '/api/%61pps', '/api/apps/%2e', '/api/apps/%2E%2E', '/api/apps/%2Fconfig', '/api/apps/%5Cconfig',
    '/api/apps/%252e%252e', '/api/apps/%25', '/api/apps/%2A', '/api/apps/%3F', '/api/apps/%23',
    '/api/apps/%00', '/api/apps/%0A', '/api/apps/%20', '/api/apps/%7F', '/api/apps/a b',
    '/api/apps/%', '/api/apps/%ZZ', '/api/apps/%C0%AF', '/api/apps/%e4%b8%ad', '/api/apps/中',
  ])('rejects ambiguous or non-canonical path %j', (path) => {
    expect(() => issueSelfApiGrant({ method: METHOD, path })).toThrow(/canonical literal/)
  })

  it('accepts a canonical encoded literal without accepting a different spelling', () => {
    const path = '/api/apps/%E4%B8%AD'
    const grant = issueSelfApiGrant({ method: 'GET', path })
    expect(resolveSelfApiGrant(grant.token, 'GET', path).decision).toBe('allowed')
    expect(resolveSelfApiGrant(grant.token, 'GET', '/api/apps/中').decision).toBe('mismatch')
  })
})

describe('bounded grant storage', () => {
  it('discards expired entries before evicting an older live grant', () => {
    vi.mocked(Date.now).mockReturnValue(NOW + 10)
    const live = issueSelfApiGrant(request)
    vi.mocked(Date.now).mockReturnValue(NOW)
    const expired = Array.from({ length: 2047 }, () => issueSelfApiGrant(request))
    vi.mocked(Date.now).mockReturnValue(NOW + TTL)
    const newest = issueSelfApiGrant(request)
    expect(resolveSelfApiGrant(live.token, METHOD, PATH).decision).toBe('allowed')
    expect(resolveSelfApiGrant(newest.token, METHOD, PATH).decision).toBe('allowed')
    expect(expired.every(grant => resolveSelfApiGrant(grant.token, METHOD, PATH).decision === 'unavailable')).toBe(true)
    expect(console.warn).toHaveBeenCalledTimes(2048)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('grant-prune'), { expired: 2047, evicted: 0, remaining: 1 },
    )
  })

  it('evicts the oldest issued grant at capacity even if it was recently used', () => {
    const grants = Array.from({ length: 2048 }, () => issueSelfApiGrant(request))
    expect(resolveSelfApiGrant(grants[0].token, METHOD, PATH).decision).toBe('allowed')
    const newest = issueSelfApiGrant(request)
    expect(resolveSelfApiGrant(grants[0].token, METHOD, PATH).decision).toBe('unavailable')
    expect(grants.slice(1).every(grant => resolveSelfApiGrant(grant.token, METHOD, PATH).decision === 'allowed')).toBe(true)
    expect(resolveSelfApiGrant(newest.token, METHOD, PATH).decision).toBe('allowed')
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('grant-prune'), { expired: 0, evicted: 1, remaining: 2047 },
    )
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(newest.token)
  })
})
