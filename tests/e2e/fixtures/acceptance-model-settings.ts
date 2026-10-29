import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { AISourcesConfig } from '../../../src/shared/types/ai-sources'
import { test as base, expect } from './acceptance-management'
import { startAcceptanceModel } from './acceptance-model'

export const PROVIDER_RESPONSE = 'Local provider configuration verified'
export type ProviderEndpoint = 'primary' | 'secondary'

export interface ProviderGatewayRequest {
  endpoint: ProviderEndpoint | 'unknown'
  method: string
  path: string
  model?: string
  authorized: boolean
  status: number
}

export interface ProviderGateway {
  url(endpoint: ProviderEndpoint): string
  key(endpoint: ProviderEndpoint): string
  requests: ProviderGatewayRequest[]
  errors: string[]
  close(): Promise<void>
}

const bodyLimit = 4 * 1024 * 1024
const availableModels = new Set(['gpt-4o', 'gpt-4o-mini'])

export async function startProviderGateway(): Promise<ProviderGateway> {
  const model = await startAcceptanceModel()
  model.respond(() => ({ text: PROVIDER_RESPONSE }))
  const keys = { primary: `local-only-${randomBytes(24).toString('hex')}`, secondary: `local-only-${randomBytes(24).toString('hex')}` }
  const requests: ProviderGatewayRequest[] = []
  const errors = model.errors
  const sockets = new Set<Socket>()
  const forwarding = new Set<ClientRequest>()
  let closing = false

  function reply(response: ServerResponse, record: ProviderGatewayRequest, status: number, message: string) {
    record.status = status
    if (response.destroyed || response.headersSent) return
    response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
    response.end(JSON.stringify({ error: { type: status === 401 ? 'authentication_error' : 'invalid_request_error', message } }))
  }

  function body(request: IncomingMessage, response: ServerResponse, record: ProviderGatewayRequest): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      const finish = (value: Buffer | null) => {
        if (done) return
        done = true
        resolve(value)
      }
      request.on('data', (chunk: Buffer) => {
        if (done) return
        size += chunk.length
        if (size > bodyLimit) {
          record.status = 413
          response.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
          response.end(JSON.stringify({ error: { message: 'Provider request exceeds 4 MiB' } }), () => request.destroy())
          request.pause()
          finish(null)
          return
        }
        chunks.push(chunk)
      })
      request.once('end', () => finish(Buffer.concat(chunks)))
      request.once('aborted', () => { record.status ||= 499; finish(null) })
      request.once('error', error => { if (!done) { done = true; reject(error) } })
    })
  }

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const part = url.pathname.split('/')[1]
    const endpoint = part === 'primary' || part === 'secondary' ? part : 'unknown'
    const supplied = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice('Bearer '.length)
      : request.headers['x-api-key']
    const authorized = endpoint !== 'unknown' && supplied === keys[endpoint]
    const record: ProviderGatewayRequest = { endpoint, method: request.method ?? '', path: url.pathname.replaceAll(keys.primary, '[redacted]').replaceAll(keys.secondary, '[redacted]'), authorized, status: 0 }
    requests.push(record)
    if (endpoint === 'unknown') { reply(response, record, 404, 'Unknown local provider endpoint'); return }
    if (!authorized) { reply(response, record, 401, 'Invalid API key'); return }
    const route = url.pathname.slice(endpoint.length + 1)
    if (request.method === 'GET' && route === '/v1/models') {
      record.status = 200
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [...availableModels].map(id => ({ id, object: 'model', owned_by: 'local-acceptance' })) }))
      return
    }
    if (request.method !== 'POST' || !/\/(?:chat\/completions|messages(?:\/count_tokens)?)$/.test(route)) {
      reply(response, record, 404, 'Unsupported local provider route')
      return
    }
    const data = await body(request, response, record)
    if (!data || response.destroyed) return
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(data.toString('utf8')) }
    catch { reply(response, record, 400, 'Invalid request JSON'); return }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { reply(response, record, 400, 'Invalid request JSON'); return }
    if (typeof parsed.model === 'string') record.model = parsed.model.replaceAll(keys.primary, '[redacted]').replaceAll(keys.secondary, '[redacted]').slice(0, 200)
    if (typeof parsed.model !== 'string' || !availableModels.has(parsed.model)) {
      reply(response, record, 400, 'Requested model is not available')
      return
    }

    await new Promise<void>(resolve => {
      const upstream = httpRequest(new URL(route, model.url), {
        method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      })
      forwarding.add(upstream)
      const abort = () => { if (!response.writableFinished) { record.status ||= 499; upstream.destroy() } }
      response.once('close', abort)
      request.once('aborted', abort)
      upstream.once('close', () => { forwarding.delete(upstream); response.off('close', abort); request.off('aborted', abort); resolve() })
      upstream.once('error', (error: NodeJS.ErrnoException) => {
        if (closing || response.destroyed || request.aborted) return
        errors.push(`Provider forwarding failed: endpoint=${endpoint}, code=${error.code ?? error.name}`)
        reply(response, record, 502, 'Local provider transport failed')
        if (response.headersSent && !response.writableEnded) response.destroy()
      })
      upstream.once('response', incoming => {
        record.status = incoming.statusCode ?? 502
        if (response.destroyed) { incoming.destroy(); return }
        response.writeHead(record.status, {
          'Content-Type': incoming.headers['content-type'] ?? 'application/json',
          'Cache-Control': 'no-cache',
        })
        incoming.once('error', (error: NodeJS.ErrnoException) => {
          if (!closing && !response.destroyed) errors.push(`Provider response failed: endpoint=${endpoint}, code=${error.code ?? error.name}`)
          response.destroy()
        })
        incoming.pipe(response)
      })
      upstream.end(data)
    })
  }

  const server = createServer((request, response) => {
    void serve(request, response).catch((error: NodeJS.ErrnoException) => {
      if (!closing && !request.aborted) errors.push(`Provider gateway failed: code=${error.code ?? error.name}`)
      if (!response.destroyed && !response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Local provider failed' } }))
      else response.destroy()
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  } catch (error) { await model.close(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') { await model.close(); throw new Error('The provider gateway has no loopback TCP address') }
  return {
    url(endpoint) { return `http://127.0.0.1:${address.port}/${endpoint}/v1` },
    key(endpoint) { return keys[endpoint] },
    requests,
    errors,
    async close() {
      if (closing) return
      closing = true
      for (const request of forwarding) request.destroy()
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
      finally { await model.close() }
    },
  }
}

interface ModelSettingsFixtures { providerGateway: ProviderGateway }

export const test = base.extend<ModelSettingsFixtures>({
  providerGateway: [async ({}, use, testInfo) => {
    const gateway = await startProviderGateway()
    try { await use(gateway) }
    finally {
      await gateway.close()
      await testInfo.attach('provider-request-metadata', { body: JSON.stringify(gateway.requests, null, 2), contentType: 'application/json' })
      expect(gateway.errors, 'The local provider and its scripted model must complete without fixture errors').toEqual([])
    }
  }, { auto: true }],
})

export function modelSettingsAcceptance(caseId: string, mode: 'scripted' | 'none' = 'scripted', variant: Record<string, string> = {}) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode, variant }) } }
}

export function aiSection(page: Page): Locator { return page.locator('#ai-model') }

export function providerField(page: Page, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return aiSection(page).locator('label').filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }).locator('..').locator('input')
}

export function readProviderConfiguration(profile: string): AISourcesConfig {
  const configuration = JSON.parse(readFileSync(join(profile, '.halo/config.json'), 'utf8'))
  return configuration.aiSources as AISourcesConfig
}

export function sourceCard(page: Page, name: string): Locator {
  return aiSection(page).getByText(name, { exact: true }).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " border ") and contains(concat(" ", normalize-space(@class), " "), " rounded-lg ")][1]')
}

export { expect } from '@playwright/test'
