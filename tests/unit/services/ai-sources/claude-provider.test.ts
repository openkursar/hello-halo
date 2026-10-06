import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AISourcesConfig, OAuthCompleteResult, OAuthSourceConfig } from '../../../../src/shared/types'

const proxyFetch = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/main/services/proxy-fetch', () => ({ proxyFetch }))

import { getClaudeProvider } from '../../../../src/main/services/ai-sources/providers/claude.provider'

function configWith(sourceId = 'account-a', overrides: Partial<OAuthSourceConfig> = {}): AISourcesConfig {
  return {
    claude: {
      sourceId,
      loggedIn: true,
      accessToken: `access-${sourceId}`,
      refreshToken: `refresh-${sourceId}`,
      tokenExpires: Date.now() + 60 * 60 * 1000,
      model: 'claude-sonnet-4-6',
      availableModels: [],
      user: { name: `${sourceId}@example.com`, uid: sourceId },
      ...overrides
    }
  } as unknown as AISourcesConfig
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 3600,
    account: { uuid: 'account-uuid', email_address: 'user@example.com' },
    ...overrides
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type LoginData = OAuthCompleteResult & {
  _tokenData: { accessToken: string; refreshToken: string; uid: string }
}

describe('ClaudeProvider account isolation', () => {
  const provider = getClaudeProvider()

  beforeEach(async () => {
    await provider.cancelLogin()
    proxyFetch.mockReset()
  })

  afterEach(async () => { await provider.cancelLogin() })

  it('uses only the selected account credentials, model and identity', async () => {
    const a = configWith('account-a')
    const b = configWith('account-b', { model: 'claude-opus-4-6[1m]' })
    const backendA = provider.getBackendConfig(a)!
    const backendB = provider.getBackendConfig(b)!
    expect(backendA.sourceId).toBe('account-a')
    expect(backendB.sourceId).toBe('account-b')
    expect(backendA.key).toBe('access-account-a')
    expect(backendB.headers?.Authorization).toBe('Bearer access-account-b')
    expect(backendB.model).toBe('claude-opus-4-6[1m]')
    expect(backendA.headers?.['anthropic-beta']).not.toContain('context-1m')
    expect(backendB.headers?.['anthropic-beta']).toContain('context-1m')
    expect(provider.getUserInfo(a)?.uid).toBe('account-a')
    expect(provider.getUserInfo(b)?.uid).toBe('account-b')
    await provider.logout(a)
    expect(provider.getBackendConfig(b)?.key).toBe(backendB.key)
  })

  it('keeps expiry checks and refreshed tokens scoped to each config without writing config', async () => {
    const a = configWith('account-a', { tokenExpires: Date.now() - 1000 })
    const b = configWith('account-b')
    expect(provider.checkTokenWithConfig(a).needsRefresh).toBe(true)
    expect(provider.checkTokenWithConfig(b).needsRefresh).toBe(false)
    proxyFetch.mockImplementation(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string)
      return tokenResponse({ access_token: `new-${body.refresh_token}`, refresh_token: undefined })
    })
    const [refreshA, refreshB] = await Promise.all([
      provider.refreshTokenWithConfig(a), provider.refreshTokenWithConfig(b)
    ])
    expect(refreshA.data).toMatchObject({ accessToken: 'new-refresh-account-a', refreshToken: 'refresh-account-a' })
    expect(refreshB.data).toMatchObject({ accessToken: 'new-refresh-account-b', refreshToken: 'refresh-account-b' })
    expect(provider.getBackendConfig(a)?.key).toBe('access-account-a')
    expect(provider.getBackendConfig(b)?.key).toBe('access-account-b')
    expect(proxyFetch.mock.calls.every(([, options]) => options.signal instanceof AbortSignal)).toBe(true)
  })

  it('returns a legacy refresh slice with the selected source identity and tokens intact', async () => {
    const result = await provider.refreshConfig(configWith('account-b'))
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ claude: { sourceId: 'account-b', accessToken: 'access-account-b' } })
    expect(proxyFetch).not.toHaveBeenCalled()
  })

  it('uses the token account UUID as stable identity across token and email changes', async () => {
    proxyFetch.mockResolvedValueOnce(tokenResponse())
    const first = await provider.startLogin()
    const loginA = await provider.completeLogin(`code-a#${first.data!.state}`)
    proxyFetch.mockResolvedValueOnce(tokenResponse({
      access_token: 'rotated-access',
      account: { uuid: 'account-uuid', email_address: 'renamed@example.com' }
    }))
    const second = await provider.startLogin()
    const loginB = await provider.completeLogin(`code-b#${second.data!.state}`)
    expect(loginA.data?.user?.uid).toBe('account-uuid')
    expect(loginB.data?.user?.uid).toBe('account-uuid')
    expect((loginB.data as LoginData)._tokenData.uid).toBe('account-uuid')
    expect(loginB.data?.user?.name).toBe('renamed@example.com')
    expect(proxyFetch).toHaveBeenCalledTimes(2)
  })

  it('enriches missing identity with this token profile, not an email-derived identity', async () => {
    proxyFetch.mockResolvedValueOnce(tokenResponse({ account: undefined }))
      .mockResolvedValueOnce(Response.json({ account: { uuid: 'profile-uuid', email: 'profile@example.com' } }))
    const start = await provider.startLogin()
    const result = await provider.completeLogin(`code#${start.data!.state}`)
    expect(result.data?.user).toEqual({ name: 'profile@example.com', uid: 'profile-uuid' })
    expect(proxyFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer new-access')
    expect(proxyFetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('does not attach a mismatched profile or invent an identity when enrichment fails', async () => {
    proxyFetch.mockResolvedValueOnce(tokenResponse({ account: { uuid: 'verified-uuid' } }))
      .mockResolvedValueOnce(Response.json({ account: { uuid: 'other-uuid', email: 'other@example.com' } }))
    const startA = await provider.startLogin()
    const first = await provider.completeLogin(`code#${startA.data!.state}`)
    expect(first.data?.user).toEqual({ name: 'Claude User', uid: 'verified-uuid' })
    proxyFetch.mockResolvedValueOnce(tokenResponse({ account: undefined }))
      .mockRejectedValueOnce(new Error('Profile unavailable'))
    const startB = await provider.startLogin()
    const second = await provider.completeLogin(`code#${startB.data!.state}`)
    expect(second.success).toBe(true)
    expect(second.data?.user?.uid).toBe('')
  })

  it('names a stored credential\'s account from its own profile, and nothing when the profile is unavailable', async () => {
    proxyFetch.mockResolvedValueOnce(Response.json({ account: { uuid: 'stored-uuid' } }))
    expect(await provider.getAccountId!(configWith('legacy', { user: { name: 'Claude User', uid: '' } }))).toBe('stored-uuid')
    expect(proxyFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer access-legacy')
    proxyFetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    expect(await provider.getAccountId!(configWith('expired'))).toBeNull()
    expect(await provider.getAccountId!(configWith('signed-out', { accessToken: '' }))).toBeNull()
    expect(proxyFetch).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid state without consuming the valid pending login', async () => {
    const start = await provider.startLogin()
    expect((await provider.completeLogin('code#wrong-state')).success).toBe(false)
    expect(proxyFetch).not.toHaveBeenCalled()
    proxyFetch.mockResolvedValueOnce(tokenResponse())
    expect((await provider.completeLogin(`code#${start.data!.state}`)).success).toBe(true)
  })

  it('logout leaves another pending authorization intact while cancelLogin affects no stored account', async () => {
    const start = await provider.startLogin()
    await provider.logout(configWith('account-a'))
    proxyFetch.mockResolvedValueOnce(tokenResponse())
    expect((await provider.completeLogin(`code#${start.data!.state}`)).success).toBe(true)
    const next = await provider.startLogin()
    await provider.cancelLogin()
    expect((await provider.completeLogin(`code#${next.data!.state}`)).success).toBe(false)
    expect(provider.getBackendConfig(configWith('account-b'))?.key).toBe('access-account-b')
  })

  it('discards cancelled token exchanges without enriching their profile', async () => {
    const response = deferred<Response>()
    proxyFetch.mockReturnValueOnce(response.promise)
    const start = await provider.startLogin()
    const completion = provider.completeLogin(`code#${start.data!.state}`)
    await provider.cancelLogin()
    response.resolve(tokenResponse({ account: undefined }))
    await expect(completion).resolves.toMatchObject({ success: false, error: 'Authentication cancelled' })
    expect(proxyFetch).toHaveBeenCalledTimes(1)
  })

  it('an old completion cannot clear a replacement authorization', async () => {
    const response = deferred<Response>()
    proxyFetch.mockReturnValueOnce(response.promise)
    const first = await provider.startLogin()
    const old = provider.completeLogin(`old-code#${first.data!.state}`)
    const replacement = await provider.startLogin()
    response.resolve(tokenResponse())
    expect((await old).success).toBe(false)
    proxyFetch.mockResolvedValueOnce(tokenResponse())
    expect((await provider.completeLogin(`new-code#${replacement.data!.state}`)).success).toBe(true)
    const body = JSON.parse(proxyFetch.mock.calls[1][1].body)
    expect(body.state).toBe(replacement.data!.state)
    expect(body.code_verifier).not.toBe(JSON.parse(proxyFetch.mock.calls[0][1].body).code_verifier)
  })

  it('rejects malformed refresh responses without returning usable credentials', async () => {
    for (const invalid of [{ access_token: '' }, { access_token: 42 }, { expires_in: 0 }, { expires_in: '3600' }]) {
      proxyFetch.mockResolvedValueOnce(tokenResponse(invalid))
      const result = await provider.refreshTokenWithConfig(configWith())
      expect(result).toMatchObject({ success: false, error: 'Invalid token response' })
      expect(result.data).toBeUndefined()
    }
  })
})
