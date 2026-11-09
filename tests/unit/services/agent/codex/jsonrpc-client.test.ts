/**
 * Unit Tests: services/agent/codex — JSON-RPC client (in-memory streams)
 *
 * Asserts wire-level behavior: line-delimited JSON framing, no jsonrpc:"2.0"
 * field, request/response correlation, server-request dispatch, transport
 * close cleanup.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'stream'
import { JsonRpcClient } from '../../../../../src/main/services/agent/codex/transport/jsonrpc-client'
import {
  registerServerRequestHandlers,
  type AskQuestionPayload,
  type ServerRequestHandlerDeps,
} from '../../../../../src/main/services/agent/codex/transport/server-request-handler'
import { ServerRequestMethods } from '../../../../../src/main/services/agent/codex/types/codex-protocol'

function makeClient() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const client = new JsonRpcClient({ stdin, stdout })

  const written: string[] = []
  stdin.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line) written.push(line)
    }
  })

  return { stdin, stdout, client, written }
}

function emit(stream: PassThrough, msg: object): void {
  stream.write(JSON.stringify(msg) + '\n')
}

describe('JsonRpcClient', () => {
  it('frames an outgoing request as a single JSON line with no jsonrpc field', async () => {
    const { client, stdout, written } = makeClient()
    const promise = client.request<{ ok: true }>('initialize', { capabilities: { experimentalApi: true } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(written).toHaveLength(1)
    const sent = JSON.parse(written[0])
    expect(sent).toMatchObject({ method: 'initialize', params: { capabilities: { experimentalApi: true } } })
    expect(sent.jsonrpc).toBeUndefined()
    expect(typeof sent.id).toBe('number')

    emit(stdout, { id: sent.id, result: { ok: true } })
    await expect(promise).resolves.toEqual({ ok: true })
    client.close()
  })

  it('rejects with the server error payload and surfaces error code + data', async () => {
    const { client, stdout, written } = makeClient()
    const promise = client.request('thread/start', {})
    await new Promise((resolve) => setImmediate(resolve))
    const id = JSON.parse(written[0]).id
    emit(stdout, { id, error: { code: -32602, message: 'invalid params', data: { field: 'model' } } })
    await expect(promise).rejects.toThrow(/invalid params \(code -32602\)/)
    client.close()
  })

  it('dispatches notifications to subscribed listeners only', async () => {
    const { client, stdout } = makeClient()
    const aSeen: unknown[] = []
    const bSeen: unknown[] = []
    client.onNotification('item/agentMessage/delta', (p) => aSeen.push(p))
    client.onNotification('turn/completed', (p) => bSeen.push(p))

    emit(stdout, { method: 'item/agentMessage/delta', params: { delta: 'a' } })
    emit(stdout, { method: 'turn/completed', params: { threadId: 't', turnId: 'r' } })
    emit(stdout, { method: 'unhandled', params: {} })
    await new Promise((resolve) => setImmediate(resolve))

    expect(aSeen).toEqual([{ delta: 'a' }])
    expect(bSeen).toEqual([{ threadId: 't', turnId: 'r' }])
    client.close()
  })

  it('answers server requests with the handler result preserving the id', async () => {
    const { client, stdout, written } = makeClient()
    client.onServerRequest('item/commandExecution/requestApproval', async () => ({ decision: 'approved' }))
    emit(stdout, { id: 42, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(written).toHaveLength(1)
    const reply = JSON.parse(written[0])
    expect(reply).toEqual({ id: 42, result: { decision: 'approved' } })
    client.close()
  })

  it('reports method-not-found for unhandled server requests', async () => {
    const { client, stdout, written } = makeClient()
    emit(stdout, { id: 'r-7', method: 'item/tool/call', params: {} })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const reply = JSON.parse(written[0])
    expect(reply.id).toBe('r-7')
    expect(reply.error.code).toBe(-32601)
    expect(reply.error.message).toMatch(/Unhandled server request/)
    client.close()
  })

  it('rejects pending requests when the connection closes', async () => {
    const { client, stdout, written } = makeClient()
    const a = client.request('thread/start', {})
    const b = client.request('turn/start', {})
    await new Promise((resolve) => setImmediate(resolve))
    expect(written).toHaveLength(2)
    stdout.end()
    await expect(a).rejects.toThrow(/connection closed/)
    await expect(b).rejects.toThrow(/connection closed/)
  })

  it('drops non-JSON lines without throwing', async () => {
    const { client, stdout } = makeClient()
    let parseErrors = 0
    const mute = console.warn
    console.warn = () => { parseErrors++ }
    try {
      stdout.write('this is not json\n')
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      console.warn = mute
    }
    expect(parseErrors).toBeGreaterThan(0)
    client.close()
  })

  it('returns false from isOpen after close', () => {
    const { client } = makeClient()
    expect(client.isOpen()).toBe(true)
    client.close()
    expect(client.isOpen()).toBe(false)
  })
})

async function elicit(
  method: string,
  params: unknown,
  askQuestion: ServerRequestHandlerDeps['askQuestion'],
): Promise<unknown> {
  const { client, stdout, written } = makeClient()
  const dispose = registerServerRequestHandlers(client, {
    conversationId: 'elicitation-conversation',
    askQuestion,
  })
  try {
    emit(stdout, { id: 42, method, params })
    await new Promise((resolve) => setImmediate(resolve))
    expect(written).toHaveLength(1)
    const reply = JSON.parse(written[0])
    expect(reply.id).toBe(42)
    expect(reply.error).toBeUndefined()
    return reply.result
  } finally {
    dispose()
    client.close()
  }
}

describe('Codex elicitation answer contract', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it.each([
    { question: 'Which release channel should we use?\nChoose one.' },
    { prompt: 'Which release channel should we use?\nChoose one.' },
    {},
  ])('maps an option using the displayed question text for %j', async (input) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const askQuestion = vi.fn(async (payload: AskQuestionPayload) => {
      expect(payload.questions).toHaveLength(1)
      expect(payload.questions[0].header).toBe('Tool input')
      return {
        '0': 'Beta',
        'Tool input': 'Beta',
        [payload.questions[0].question]: 'Stable',
      }
    })
    const result = await elicit(ServerRequestMethods.ToolRequestUserInput, {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
      ...input,
      options: [{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }],
    }, askQuestion)

    expect(result).toEqual({ value: 'stable' })
    expect(askQuestion).toHaveBeenCalledOnce()
    expect(warn).not.toHaveBeenCalled()
  })

  it('preserves free-text answers keyed by the complete question', async () => {
    const result = await elicit(ServerRequestMethods.ToolRequestUserInput, {
      question: 'What should happen next?\nInclude any constraints.',
    }, async (payload) => ({ [payload.questions[0].question]: 'Keep both versions.\nDo not overwrite.' }))

    expect(result).toEqual({ value: 'Keep both versions.\nDo not overwrite.' })
  })

  it.each(['Approve', 'Deny'])('uses the MCP payload question for %s', async (answer) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await elicit(ServerRequestMethods.McpServerElicitationRequest, {
      message: 'May the MCP server proceed?\nConfirm the decision.',
    }, async (payload) => ({
      '0': answer === 'Approve' ? 'Deny' : 'Approve',
      'MCP request': answer === 'Approve' ? 'Deny' : 'Approve',
      [payload.questions[0].question]: answer,
    }))

    expect(result).toEqual({ action: answer === 'Approve' ? 'accept' : 'reject' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('uses the displayed MCP fallback question when no message is supplied', async () => {
    const result = await elicit(ServerRequestMethods.McpServerElicitationRequest, undefined,
      async (payload) => ({ [payload.questions[0].question]: 'Approve' }))

    expect(result).toEqual({ action: 'accept' })
  })

  it.each([
    { method: ServerRequestMethods.ToolRequestUserInput, params: { question: 'Private tool question' }, result: { value: '' } },
    { method: ServerRequestMethods.McpServerElicitationRequest, params: { message: 'Private MCP question' }, result: { action: 'reject' } },
  ])('does not read header or numeric keys for $method and logs no user content', async ({ method, params, result }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = 'Approve private answer'
    expect(await elicit(method, params, async () => ({
      '0': answer,
      'Tool input': answer,
      'MCP request': answer,
    }))).toEqual(result)

    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[Codex][elicitation]'), {
      conversationId: 'elicitation-conversation',
    })
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('Private')
    expect(logged).not.toContain(answer)
  })
})
