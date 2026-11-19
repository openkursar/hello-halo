import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { modelTool, type ModelRequest, type ModelReply } from './acceptance-model'
import { expect } from './acceptance-app'

export async function securityCredentialRelay(upstream: string) {
  const authorizations: Array<string | undefined> = []
  const server = createServer((incoming, outgoing) => {
    if (incoming.method === 'POST' && !incoming.url?.endsWith('/count_tokens')) authorizations.push(incoming.headers.authorization)
    const destination = new URL(incoming.url ?? '/', upstream)
    const forwarded = httpRequest(destination, { method: incoming.method, headers: { ...incoming.headers, host: destination.host } }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(outgoing)
    })
    forwarded.on('error', error => outgoing.destroy(error))
    incoming.pipe(forwarded)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, authorizations,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}

export function decodeSecurityResult(text: string): any {
  const value = JSON.parse(text.replace(/^Wall time: \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/, ''))
  return Array.isArray(value) && value[0]?.type === 'text' ? JSON.parse(value[0].text) : value
}

export function securityTool(request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply {
  const advertised = request.tools.find(tool => tool === name || tool.endsWith(`__${name}`))
  const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.name ?? tool.function?.name) === advertised)
  const discovery = `discover-${name}`
  if (advertised && (!definition?.defer_loading && !definition?.function?.defer_loading || request.toolResults.some(result => result.id === discovery))) {
    return { tools: [modelTool(request, name, input, id)] }
  }
  return { tools: [modelTool(request, 'ToolSearch', { query: `select:mcp__halo-team__${name}`, max_results: 1 }, discovery)] }
}

export function refusedSecurityResult(text: string) {
  return /forbidden|not allowed|not permitted|denied|stale|changed|removed|unavailable|not found|unknown|unexpected argument|invalid|policy/i.test(text)
}

export async function addSecuritySource(page: Page, url: string, name: string, modelId = 'gpt-4o') {
  expect(new URL(url).hostname).toBe('127.0.0.1')
  const sourceId = `acceptance-security-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const timestamp = new Date().toISOString()
  const result = await page.evaluate(({ url, name, modelId, sourceId, timestamp }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesAddSource({
    id: sourceId, createdAt: timestamp, updatedAt: timestamp,
    name, provider: 'openai', authType: 'api-key', apiUrl: url, apiKey: 'isolated-security-fixture',
    apiType: 'chat_completions', model: modelId, availableModels: [{ id: modelId, name: modelId }],
  }), { url, name, modelId, sourceId, timestamp })
  expect(result.success, result.error).toBe(true)
  const configuration = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
  const sources = (configuration.data as { aiSources: { sources: Array<{ id: string; name: string }> } }).aiSources.sources
  const source = sources.find(source => source.name === name)
  expect(source).toBeTruthy()
  expect(source!.id).toBe(sourceId)
  expect(source!.id.length).toBeGreaterThan(0)
  const selected = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesSwitchSource('acceptance-local'))
  expect(selected.success, selected.error).toBe(true)
  return source!.id
}

export async function securityConversation(page: Page, message: string, conversationId?: string, reasoningEffort?: 'high' | 'max') {
  if (!conversationId) {
    const created = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Assignment security'))
    expect(created.success, created.error).toBe(true)
    conversationId = (created.data as { id: string }).id
  }
  const sent = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage(input), {
    spaceId: 'halo-temp', conversationId, message, reasoningEffort,
  })
  expect(sent.success, sent.error).toBe(true)
  return conversationId
}
