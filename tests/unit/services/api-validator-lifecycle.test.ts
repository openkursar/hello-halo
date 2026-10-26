import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }))
vi.mock('../../../src/main/services/agent/resolved-sdk', () => ({ createSession }))
vi.mock('../../../src/main/services/agent/sdk-config', () => ({ buildSdkEnv: () => ({}), resolveClaudeCodeCliPath: () => '/fixture/cli' }))
vi.mock('../../../src/main/services/agent/helpers', () => ({ getHeadlessElectronPath: () => '/fixture/electron' }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getTempSpacePath: () => '/fixture/workspace' }))
vi.mock('../../../src/main/services/proxy-fetch', () => ({ proxyFetch: vi.fn() }))
vi.mock('../../../src/main/openai-compat-router', () => ({
  normalizeApiUrl: (url: string) => url,
  ensureOpenAICompatRouter: async () => ({ baseUrl: 'http://127.0.0.1:51234' }),
  encodeBackendConfig: () => 'synthetic-encoded-validation-credential',
}))

import { validateApiConnection } from '../../../src/main/services/api-validator.service'

const params = { provider: 'anthropic' as const, apiKey: 'synthetic-sensitive-validation-key', apiUrl: 'https://fixture.example/v1', model: 'fixture-model' }
const success = { type: 'result', subtype: 'success', is_error: false, result: 'OK' }
const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'private-model-response' }] } }

function sessionWith(frames: unknown[]) {
  const session = { send: vi.fn(), close: vi.fn(), stream: async function* () { for (const frame of frames) yield frame } }
  createSession.mockResolvedValue(session)
  return session
}

beforeEach(() => {
  createSession.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('connection validation terminal outcomes', () => {
  it.each([[success], [assistant, success]])('accepts an explicit successful terminal result and closes the session', async (...frames) => {
    const session = sessionWith(frames)
    expect(await validateApiConnection(params)).toMatchObject({ valid: true, message: 'Connection successful' })
    expect(session.send).toHaveBeenCalledWith('test')
    expect(session.close).toHaveBeenCalledTimes(1)
    expect(createSession.mock.calls[0][0].abortController.signal.aborted).toBe(true)
  })

  it.each([
    [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['401 Unauthorized'] }],
    [assistant, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['401 Unauthorized'] }],
    [{ ...assistant, error: 'authentication_failed' }, success],
    [{ type: 'error', error: '401 Unauthorized' }, success],
    [{ ...success, is_error: true, errors: ['401 Unauthorized'] }],
  ])('never lets an assistant or a contradictory result conceal authentication failure', async (...frames) => {
    const session = sessionWith(frames)
    expect(await validateApiConnection(params)).toMatchObject({ valid: false, message: 'Invalid API key' })
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable model without exposing the provider payload', async () => {
    sessionWith([assistant, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`400 Requested model is not available; ${params.apiKey}`] }])
    expect(await validateApiConnection(params)).toMatchObject({ valid: false, message: 'Requested model is not available' })
  })

  it.each([
    [assistant],
    [{ type: 'system', subtype: 'init' }],
    [{ type: 'result' }],
    [{ ...success, subtype: 'error_max_turns' }],
    [{ ...success, errors: ['provider execution failed'] }],
  ])('rejects incomplete or unsuccessful turns even if response frames exist', async (...frames) => {
    const session = sessionWith(frames)
    expect(await validateApiConnection(params)).toMatchObject({ valid: false })
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('allows a recoverable retry notice followed by actual success', async () => {
    sessionWith([{ type: 'system', subtype: 'api_retry', error: 'rate_limit' }, assistant, success])
    expect(await validateApiConnection(params)).toMatchObject({ valid: true })
  })

  it('never logs credentials, raw provider errors or model text', async () => {
    sessionWith([assistant, success])
    await validateApiConnection(params)
    sessionWith([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`opaque-private-provider-detail ${params.apiKey}`] }])
    expect(await validateApiConnection(params)).toMatchObject({ valid: false, message: 'Connection failed' })
    const logs = JSON.stringify([vi.mocked(console.log).mock.calls, vi.mocked(console.warn).mock.calls, vi.mocked(console.error).mock.calls])
    for (const value of [params.apiKey, 'opaque-private-provider-detail', 'private-model-response']) expect(logs).not.toContain(value)
  })
})

describe('connection validation cleanup and deadlines', () => {
  it('awaits rejected sends and closes their session', async () => {
    const session = sessionWith([])
    session.send.mockRejectedValue(new Error('401 Unauthorized'))
    expect(await validateApiConnection(params)).toMatchObject({ valid: false, message: 'Invalid API key' })
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('closes a session when its response iterator throws', async () => {
    const close = vi.fn()
    createSession.mockResolvedValue({ send: vi.fn(), close, stream: async function* () { yield assistant; throw new Error('ECONNRESET') } })
    expect(await validateApiConnection(params)).toMatchObject({ valid: false, message: 'Cannot connect to API server - check URL' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('returns at the deadline and closes a stream that produces no further frames', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const stalled = new Promise<void>(resolve => { release = resolve })
    const close = vi.fn(() => release())
    createSession.mockResolvedValue({ send: vi.fn(), close, stream: async function* () { yield assistant; await stalled } })
    const result = validateApiConnection(params)
    await vi.advanceTimersByTimeAsync(15000)
    expect(await result).toMatchObject({ valid: false, message: 'Connection timeout - server may be slow or unreachable' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes a session that finishes creating only after validation timed out', async () => {
    vi.useFakeTimers()
    let finishCreation!: (value: unknown) => void
    createSession.mockImplementation(() => new Promise(resolve => { finishCreation = resolve }))
    const result = validateApiConnection(params)
    await vi.advanceTimersByTimeAsync(15000)
    expect(await result).toMatchObject({ valid: false, message: 'Connection timeout - server may be slow or unreachable' })
    const late = { send: vi.fn(), close: vi.fn(), stream: vi.fn() }
    finishCreation(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(late.close).toHaveBeenCalledTimes(1)
    expect(late.send).not.toHaveBeenCalled()
    expect(late.stream).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not enter streaming after a send outlives its deadline', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const sent = new Promise<void>(resolve => { release = resolve })
    const stream = vi.fn()
    const close = vi.fn(() => release())
    createSession.mockResolvedValue({ send: vi.fn(() => sent), close, stream })
    const result = validateApiConnection(params)
    await vi.advanceTimersByTimeAsync(15000)
    expect(await result).toMatchObject({ valid: false })
    expect(close).toHaveBeenCalledTimes(1)
    expect(stream).not.toHaveBeenCalled()
  })

  it('reports a cleanup failure without logging the thrown diagnostic', async () => {
    const session = sessionWith([success])
    session.close.mockImplementation(() => { throw new Error(`private-close-diagnostic ${params.apiKey}`) })
    expect(await validateApiConnection(params)).toMatchObject({ valid: false, message: 'Connection failed' })
    expect(session.close).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('session close failed'))
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-close-diagnostic')
  })
})
