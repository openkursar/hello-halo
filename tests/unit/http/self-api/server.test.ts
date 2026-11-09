import { describe, it, expect, expectTypeOf, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { SelfApiInfo, SelfApiGrant, SelfApiGrantRequest } from '../../../../src/main/http/self-api'

const mocks = vi.hoisted(() => ({ listen: vi.fn(), issue: vi.fn(), register: vi.fn() }))
vi.mock('express', () => ({
  default: Object.assign(() => ({ set: vi.fn(), use: vi.fn(), listen: mocks.listen }), { json: vi.fn() }),
}))
vi.mock('../../../../src/main/http/routes', () => ({ registerApiRoutes: mocks.register }))
vi.mock('../../../../src/main/foundation/logging', () => ({ isDeveloperMode: () => false }))
vi.mock('../../../../src/main/http/self-api/token-store', () => ({
  issueSelfApiToken: mocks.issue,
  resolveSelfApiToken: vi.fn(),
}))

/** A bind the OS refuses, failing the way Express 5 does: the listen callback receives the error first. */
function refusedBind(code: string) {
  return (_port: number, _host: string, onListening: (error?: Error) => void) => {
    const server = new EventEmitter()
    server.once('error', onListening)
    queueMicrotask(() => server.emit('error', Object.assign(new Error(`bind ${code}`), { code })))
    return server
  }
}

beforeEach(() => {
  vi.resetModules()
  mocks.issue.mockImplementation((spaceId: string) => `regular-${spaceId}`)
  mocks.listen.mockImplementation((_port, _host, onListening) => {
    queueMicrotask(onListening)
    return new EventEmitter()
  })
})

describe('self-API public listener contract', () => {
  it('starts and reuses the listener without issuing a token when no space is supplied', async () => {
    const { ensureSelfApiServer } = await import('../../../../src/main/http/self-api')
    const first = ensureSelfApiServer()
    expectTypeOf(first).toEqualTypeOf<Promise<{ url: string }>>()
    expect(await first).toEqual({ url: 'http://127.0.0.1:4791' })
    expect(await ensureSelfApiServer()).toEqual(await first)
    expect(mocks.listen).toHaveBeenCalledTimes(1)
    expect(mocks.register).toHaveBeenCalledWith(expect.anything(), { assistant: true })
    expect(mocks.listen).toHaveBeenCalledWith(4791, '127.0.0.1', expect.any(Function))
    expect(mocks.register).toHaveBeenCalledTimes(1)
    expect(mocks.issue).not.toHaveBeenCalled()
  })

  it('retains the existing spaceId overload after token-free startup', async () => {
    const { ensureSelfApiServer } = await import('../../../../src/main/http/self-api')
    await ensureSelfApiServer()
    const regular = ensureSelfApiServer('space-a')
    expectTypeOf(regular).toEqualTypeOf<Promise<SelfApiInfo>>()
    expect(await regular).toEqual({ url: 'http://127.0.0.1:4791', token: 'regular-space-a' })
    expect(mocks.issue.mock.calls).toEqual([['space-a']])
    expect(mocks.listen).toHaveBeenCalledTimes(1)
  })

  it('returns no credential from a no-argument call after a regular-token call', async () => {
    const { ensureSelfApiServer } = await import('../../../../src/main/http/self-api')
    await ensureSelfApiServer('space-a')
    expect(await ensureSelfApiServer()).toEqual({ url: 'http://127.0.0.1:4791' })
    expect(mocks.issue).toHaveBeenCalledTimes(1)
    expect(mocks.listen).toHaveBeenCalledTimes(1)
  })

  it('shares a single startup across concurrent callers with and without a space', async () => {
    const { ensureSelfApiServer } = await import('../../../../src/main/http/self-api')
    const result = await Promise.all([
      ensureSelfApiServer(), ensureSelfApiServer('space-a'), ensureSelfApiServer(), ensureSelfApiServer('space-b'),
    ])
    expect(result).toEqual([
      { url: 'http://127.0.0.1:4791' },
      { url: 'http://127.0.0.1:4791', token: 'regular-space-a' },
      { url: 'http://127.0.0.1:4791' },
      { url: 'http://127.0.0.1:4791', token: 'regular-space-b' },
    ])
    expect(mocks.listen).toHaveBeenCalledTimes(1)
    expect(mocks.issue.mock.calls).toEqual([['space-a'], ['space-b']])
  })

  it('retains startup retry after failure without issuing a regular token', async () => {
    mocks.listen.mockImplementationOnce(refusedBind('EACCES'))
    const { ensureSelfApiServer } = await import('../../../../src/main/http/self-api')
    await expect(ensureSelfApiServer()).rejects.toThrow('bind EACCES')
    expect(await ensureSelfApiServer()).toEqual({ url: 'http://127.0.0.1:4791' })
    expect(mocks.listen).toHaveBeenCalledTimes(2)
    expect(mocks.issue).not.toHaveBeenCalled()
  })

  it('hands sessions the port it actually bound when the default one is taken', async () => {
    // Another Halo on this machine holds 4791; its tokens are not this process's.
    mocks.listen.mockImplementationOnce(refusedBind('EADDRINUSE'))
    const { ensureSelfApiServer } = await import('../../../../src/main/http/self-api')
    expect(await ensureSelfApiServer('space-a')).toEqual({ url: 'http://127.0.0.1:4792', token: 'regular-space-a' })
    expect(mocks.listen.mock.calls.map(([port]) => port)).toEqual([4791, 4792])
  })

  it('exports the requested generic grant API and types, but not the test reset', async () => {
    const api = await import('../../../../src/main/http/self-api')
    const request: SelfApiGrantRequest = { method: 'POST', path: '/api/example/one', validate: () => undefined }
    const grant = api.issueSelfApiGrant(request)
    expectTypeOf(grant).toEqualTypeOf<SelfApiGrant>()
    expect(grant.token).toMatch(/^halo-grant-/)
    expect(grant.expiresAt).toBeGreaterThan(Date.now())
    expect(api).not.toHaveProperty('resetSelfApiGrants')
    expect(mocks.listen).not.toHaveBeenCalled()
    expect(mocks.issue).not.toHaveBeenCalled()
  })
})
