import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the router's real HTTP path while isolating this fixture from machine proxy settings.
vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (url: string, init: RequestInit) => fetch(url, init)
}))

import {
  createSession, AnthropicProvider, createSdkMcpServer, tool,
  type SDKSession, type SDKMessage
} from '@hello-halo/agent-sdk'
import { createApp, encodeBackendConfig, setRequestCredentialResolver, setGroupPlanResolver } from '../../../src/main/openai-compat-router'

type Protocol = 'responses' | 'chat_completions'
type Reply = { name: string; id: string; input: Record<string, unknown> } | { text: string }
type WireRequest = {
  tools: Array<{ name?: string; function?: { name: string }; [key: string]: unknown }>
  input?: Array<Record<string, any>>
  messages?: Array<Record<string, any>>
  [key: string]: unknown
}
const servers: Server[] = []
const sessions: SDKSession[] = []
const directories: string[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  setRequestCredentialResolver(null)
  setGroupPlanResolver(null)
  vi.restoreAllMocks()
})
const target = 'mcp__records__lookup'
const description = 'Lookup a customer with the full record schema.'
const notesDescription = 'Read customer notes with the full notes schema.'
const guide = 'Use the customer identifier from the request and preserve its filters.'
const rawArguments = String.raw`{ "customer": "cust\u0034\u0032", "filters": { "archived": false }, "tags": ["中文", "quote: \"value\""] }`
const parsedArguments = JSON.parse(rawArguments)
const schema = {
  type: 'object', properties: {
    customer: { type: 'string' },
    filters: { type: 'object', properties: { archived: { type: 'boolean' } }, required: ['archived'], additionalProperties: false },
    tags: { type: 'array', items: { type: 'string' } }
  }, required: ['customer', 'filters', 'tags'], additionalProperties: false
}
const replies: Reply[] = [
  { name: 'ToolSearch', id: 'find-lookup', input: { query: `select:${target}` } },
  { name: 'ToolSearch', id: 'find-notes', input: { query: 'select:mcp__records__notes' } },
  { name: 'CallTool', id: 'invoke-lookup', input: { tool: target, arguments: rawArguments } },
  { text: 'The customer record was read.' }
]
function send(response: ServerResponse, event: Record<string, unknown>) {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
function sendResponses(response: ServerResponse, reply: Reply, sequence: number) {
  const id = `response-${sequence}`
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  send(response, { type: 'response.created', response: { id, model: 'fixture-model', status: 'in_progress', output: [] } })
  let output: Record<string, unknown>
  if ('name' in reply) {
    const argumentsJson = JSON.stringify(reply.input)
    output = { type: 'function_call', id: `item-${sequence}`, call_id: reply.id, name: reply.name, arguments: argumentsJson, status: 'completed' }
    send(response, { type: 'response.output_item.added', output_index: 0, item: { ...output, arguments: '', status: 'in_progress' } })
    send(response, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: output.id, delta: argumentsJson.slice(0, 17) })
    send(response, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: output.id, delta: argumentsJson.slice(17) })
    send(response, { type: 'response.function_call_arguments.done', output_index: 0, item_id: output.id, arguments: argumentsJson })
  } else {
    output = { type: 'message', id: `item-${sequence}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [] }] }
    send(response, { type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', content: [] } })
    send(response, { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: output.id, part: { type: 'output_text', text: '', annotations: [] } })
    send(response, { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: output.id, delta: reply.text })
    send(response, { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: output.id, text: reply.text })
  }
  send(response, { type: 'response.output_item.done', output_index: 0, item: output })
  send(response, { type: 'response.completed', response: { id, model: 'fixture-model', status: 'completed', output: [output],
    usage: { input_tokens: 120, output_tokens: 10, total_tokens: 130 } } })
  response.end()
}
function sendChat(response: ServerResponse, reply: Reply, sequence: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta: unknown, finish: string | null = null) => send(response, { id: `response-${sequence}`,
    object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })
  chunk({ role: 'assistant', content: '' })
  if ('name' in reply) {
    const input = JSON.stringify(reply.input)
    chunk({ tool_calls: [{ index: 0, id: reply.id, type: 'function', function: { name: reply.name, arguments: input.slice(0, 17) } }] })
    chunk({ tool_calls: [{ index: 0, function: { arguments: input.slice(17) } }] })
  } else chunk({ content: reply.text })
  chunk({}, 'name' in reply ? 'tool_calls' : 'stop')
  send(response, { id: `response-${sequence}`, choices: [], usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 } })
  response.end('data: [DONE]\n\n')
}
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
async function upstream(protocol: Protocol) {
  const requests: WireRequest[] = []
  const paths: string[] = []
  const errors: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const buffers: Buffer[] = []
      for await (const buffer of request) buffers.push(Buffer.from(buffer))
      requests.push(JSON.parse(Buffer.concat(buffers).toString('utf8')))
      paths.push(request.url ?? '')
      const reply = replies[requests.length - 1] ?? replies.at(-1)!
      if (protocol === 'responses') sendResponses(response, reply, requests.length)
      else sendChat(response, reply, requests.length)
    })().catch(error => {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Local fixture protocol error' } }))
    })
  })
  return { baseUrl: await listen(server), requests, paths, errors }
}
function result(request: WireRequest, id: string): any {
  if (request.input) return JSON.parse(String(request.input.find(item => item.type === 'function_call_output' && item.call_id === id)?.output))
  return JSON.parse(String(request.messages?.find(message => message.role === 'tool' && message.tool_call_id === id)?.content))
}
function call(request: WireRequest, id: string) {
  if (request.input) {
    const item = request.input.find(item => item.type === 'function_call' && item.call_id === id)
    return item ? { name: item.name, input: JSON.parse(String(item.arguments)) } : undefined
  }
  const item = request.messages?.flatMap(message => message.tool_calls ?? []).find(item => item.id === id)
  return item ? { name: item.function.name, input: JSON.parse(item.function.arguments) } : undefined
}
function assertNoPrivateFields(value: unknown) {
  if (Array.isArray(value)) { value.forEach(assertNoPrivateFields); return }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    expect(['toolContext', 'mcpSource', 'discoveryEntries', 'definitionVersion', 'historicalDefinitions', 'defer_loading', 'halo_defer_loading']).not.toContain(key)
    assertNoPrivateFields(child)
  }
}
function comparableMessages(messages: Array<Record<string, any>>, protocol: Protocol) {
  if (protocol === 'responses') return messages
  return messages.map(message => ({ ...message,
    content: Array.isArray(message.content) && message.content.every((part: { type?: string }) => part.type === 'text')
      ? message.content.map((part: { text: string }) => part.text).join('') : message.content
  }))
}

describe('Halo SDK deferred calls through the host router', () => {
  it.each(['responses', 'chat_completions'] as const)('uses ordinary %s wire requests while keeping discovery append-only', async protocol => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    setRequestCredentialResolver(null)
    setGroupPlanResolver(null)
    const wire = await upstream(protocol)
    const app = createApp({ timeoutMs: 5000 })
    const router = await listen(createServer(app))
    const cwd = await mkdtemp(join(tmpdir(), 'halo-deferred-router-')); directories.push(cwd)
    const permission = vi.fn(async (name: string) => ({ behavior: 'allow' as const,
      updatedInput: name === target ? { customer: 'approved-42' } : {} }))
    const handler = vi.fn(async (input: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(input) }] }))
    const key = encodeBackendConfig({ url: `${wire.baseUrl}${protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions'}`,
      key: 'synthetic-key', model: 'fixture-model', apiType: protocol })
    const provider = new AnthropicProvider({ apiKey: key, baseUrl: router })
    const session = await createSession({ model: 'fixture-model', provider, cwd,
      env: { HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'records') },
      tools: [], settingSources: [], systemPrompt: 'Follow the user request.', persistSession: false,
      permissionMode: 'default', canUseTool: permission, maxTurns: 8, turnEndChecks: { openWork: false, completion: false },
      mcpServers: { records: createSdkMcpServer({ name: 'records', instructions: guide, tools: [
        tool('lookup', description, schema, handler), tool('notes', notesDescription, schema, handler)
      ] }) },
      toolDiscovery: { services: { records: { identity: 'private-installation-identity', loading: 'deferred', summary: 'Customer record operations.' } } }
    })
    sessions.push(session)
    await session.send('Read customer42 with its supplied filters.')
    const events: SDKMessage[] = []
    for await (const event of session.stream()) { events.push(event); if (event.type === 'result') break }
    expect(events.at(-1)).toMatchObject({ is_error: false })
    expect(wire.errors).toEqual([])
    expect(wire.requests).toHaveLength(4)
    expect(wire.paths).toEqual(Array(4).fill(protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions'))
    const first = wire.requests[0]
    expect(first.tools.map(tool => tool.name ?? tool.function?.name)).toEqual(['ToolSearch', 'CallTool'])
    for (const request of wire.requests) { expect(request.tools).toEqual(first.tools); assertNoPrivateFields(request) }
    expect(JSON.stringify(first)).toContain('Customer record operations.')
    expect(JSON.stringify(first)).not.toContain(description)
    expect(JSON.stringify(first)).not.toContain(notesDescription)
    expect(JSON.stringify(first)).not.toContain(guide)
    expect(result(wire.requests[1], 'find-lookup')).toMatchObject({ tools: [{ name: target, description, input_schema: schema, usage_guide: guide }] })
    expect(result(wire.requests[2], 'find-notes')).toMatchObject({ tools: [{ name: 'mcp__records__notes', description: notesDescription, input_schema: schema }] })
    expect(call(wire.requests[3], 'invoke-lookup')).toEqual({ name: 'CallTool', input: { tool: target, arguments: rawArguments } })
    expect(JSON.stringify(wire.requests[3]).split(guide)).toHaveLength(2)
    expect(JSON.stringify(wire.requests)).not.toContain('private-installation-identity')
    for (let index = 1; index < wire.requests.length; index++) {
      const previous = wire.requests[index - 1].input ?? wire.requests[index - 1].messages!
      const current = wire.requests[index].input ?? wire.requests[index].messages!
      // Cache breakpoints make Anthropic wrap its last text string; Chat preserves either equivalent shape.
      expect(comparableMessages(current.slice(0, previous.length), protocol)).toEqual(comparableMessages(previous, protocol))
    }
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0]).toEqual({ ...parsedArguments, customer: 'approved-42' })
    expect(permission.mock.calls.map(args => args[0])).toEqual(['ToolSearch', 'ToolSearch', target])
    expect(events.filter(event => event.type === 'assistant').flatMap(event => event.message.content)
      .filter(block => block.type === 'tool_use').map(block => block.name)).toEqual(['ToolSearch', 'ToolSearch', target])
    expect(JSON.stringify(events)).not.toContain('toolContext')
  })
})
