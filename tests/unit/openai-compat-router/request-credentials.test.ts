/**
 * Each proxied request carries its account's current credential, while every
 * other field the session encoded stays as it was; a removed account fails the
 * request at the router instead of borrowing a stale token.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Express } from 'express'

const handlers = vi.hoisted(() => ({ messages: vi.fn(), responses: vi.fn() }))
vi.mock('../../../src/main/openai-compat-router/server/request-handler', () => ({
  handleMessagesRequest: handlers.messages,
  handleCountTokensRequest: vi.fn(),
}))
vi.mock('../../../src/main/openai-compat-router/server/codex-responses-handler', () => ({
  handleResponsesRequest: handlers.responses,
}))

import {
  setRequestCredentialResolver,
  withCurrentCredentials,
} from '../../../src/main/openai-compat-router/server/request-credentials'
import { createApp } from '../../../src/main/openai-compat-router/server/router'
import { encodeBackendConfig, DELEGATED_ROUTING_HEADER } from '../../../src/main/openai-compat-router'
import type { BackendConfig } from '../../../src/main/openai-compat-router/types'

const encoded: BackendConfig = {
  sourceId: 'account-a', url: 'https://old.invalid/v1', key: 'test-old-token', model: 'model-a',
  apiType: 'responses', adapterId: 'codex', headers: { Authorization: 'Bearer test-old-token' },
}

afterEach(() => {
  setRequestCredentialResolver(null)
  vi.restoreAllMocks()
  handlers.messages.mockReset()
  handlers.responses.mockReset()
})

describe('withCurrentCredentials', () => {
  it('uses the encoded config until a resolver is registered and for configs without a source', async () => {
    expect(await withCurrentCredentials(encoded)).toEqual({ config: encoded })
    const resolver = vi.fn()
    setRequestCredentialResolver(resolver)
    const unsourced = { ...encoded, sourceId: undefined }
    expect(await withCurrentCredentials(unsourced)).toEqual({ config: unsourced })
    const delegated = { ...encoded, delegatedAuth: true }
    expect(await withCurrentCredentials(delegated)).toEqual({ config: delegated })
    expect(resolver).not.toHaveBeenCalled()
  })

  it('swaps only the credential fields and asks for the session\'s own model', async () => {
    const resolver = vi.fn(async () => ({ key: 'test-new-token', headers: { Authorization: 'Bearer test-new-token' } }))
    setRequestCredentialResolver(resolver)
    const { config } = await withCurrentCredentials(encoded) as { config: BackendConfig }
    expect(resolver).toHaveBeenCalledWith('account-a', 'model-a')
    expect(config).toEqual({ ...encoded, key: 'test-new-token', headers: { Authorization: 'Bearer test-new-token' } })
  })

  it('keeps the encoded credential when the resolver has nothing newer', async () => {
    setRequestCredentialResolver(async () => null)
    expect(await withCurrentCredentials(encoded)).toEqual({ config: encoded })
  })

  it('refuses the request with the resolver\'s reason and logs it without credentials', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setRequestCredentialResolver(async () => { throw new Error('This account was removed.') })
    expect(await withCurrentCredentials(encoded)).toEqual({ error: 'This account was removed.' })
    expect(warn).toHaveBeenCalledWith('[Router] Request refused: source=account-a credential unavailable (This account was removed.)')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('test-old-token')
  })
})

describe('router endpoints', () => {
  type Route = (req: any, res: any) => Promise<void>
  function routes(): Map<string, Route> {
    const app = createApp() as unknown as Express & { router?: { stack: any[] }; _router?: { stack: any[] } }
    const found = new Map<string, Route>()
    for (const layer of (app.router ?? app._router)!.stack) {
      if (layer.route) found.set(layer.route.path, layer.route.stack.at(-1).handle)
    }
    return found
  }
  function response() {
    const res: any = { statusCode: 200, body: undefined }
    res.status = vi.fn((code: number) => { res.statusCode = code; return res })
    res.json = vi.fn((body: unknown) => { res.body = body; return res })
    return res
  }

  it('passes current credentials to both handlers and answers a removed account with 401', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const current = { key: 'test-new-token', headers: { Authorization: 'Bearer test-new-token' } }
    setRequestCredentialResolver(async () => current)
    const table = routes()
    const key = encodeBackendConfig(encoded)

    await table.get('/v1/messages')!({ headers: { 'x-api-key': key }, body: {}, url: '/v1/messages', method: 'POST', socket: {} }, response())
    expect(handlers.messages.mock.calls[0][1]).toMatchObject({ ...current, url: encoded.url, model: 'model-a', adapterId: 'codex' })
    await table.get('/v1/responses')!({ headers: { authorization: `Bearer ${key}` }, body: {}, url: '/v1/responses', method: 'POST', socket: {} }, response())
    expect(handlers.responses.mock.calls[0][1]).toMatchObject({ ...current, model: 'model-a' })

    setRequestCredentialResolver(async () => { throw new Error('This account was removed.') })
    const refused = response()
    await table.get('/v1/messages')!({ headers: { 'x-api-key': key }, body: {}, url: '/v1/messages', method: 'POST', socket: {} }, refused)
    expect(refused.statusCode).toBe(401)
    expect(refused.body).toEqual({ type: 'error', error: { type: 'authentication_error', message: 'This account was removed.' } })
    expect(handlers.messages).toHaveBeenCalledTimes(1)
  })

  it('keeps the router-local routing header away from the upstream on both paths', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const table = routes()
    const key = encodeBackendConfig(encoded)
    const request = (headers: Record<string, string>, url: string) => ({ headers, body: {}, url, method: 'POST', socket: {} })

    await table.get('/v1/messages')!(request({ 'x-api-key': key, [DELEGATED_ROUTING_HEADER]: key, 'x-client': 'cli' }, '/v1/messages'), response())
    await table.get('/v1/responses')!(request({ authorization: `Bearer ${key}`, [DELEGATED_ROUTING_HEADER]: key, 'x-client': 'cli' }, '/v1/responses'), response())

    expect(handlers.messages.mock.calls[0][3].sdkHeaders).toEqual({ 'x-client': 'cli' })
    expect(handlers.responses.mock.calls[0][3].sdkHeaders).toEqual({ 'x-client': 'cli' })
  })
})
