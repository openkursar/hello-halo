import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export interface ModelToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ModelRequest {
  sequence: number
  protocol: 'anthropic' | 'openai'
  body: Record<string, any>
  messages: Array<Record<string, any>>
  tools: string[]
  text: string
  lastUserText: string
  toolResults: Array<{ id: string; text: string; error: boolean }>
}

export interface ModelReply {
  text?: string
  tools?: ModelToolCall[]
  /** Keeps the stream open until the test releases it or the client cancels. */
  hold?: Promise<void>
}

export interface ModelExchange {
  request: ModelRequest
  startedAt: string
  reply?: { text?: string; tools?: ModelToolCall[] }
  completed: boolean
  cancelled: boolean
  error?: string
}

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    if (part?.type === 'text') return String(part.text ?? '')
    if (part?.type === 'tool_result') return contentText(part.content)
    return ''
  }).filter(Boolean).join('\n')
}

export function modelTool(request: ModelRequest, name: string, input: Record<string, unknown>, id: string = randomUUID()): ModelToolCall {
  const matches = request.tools.filter(tool => tool === name || tool.endsWith(`__${name}`))
  if (matches.length !== 1) throw new Error(`Expected one advertised ${name} tool, received ${matches.length}: ${request.tools.join(', ')}`)
  return { id, name: matches[0], input }
}

export function createModelGate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function normalizeRequest(body: Record<string, any>, protocol: ModelRequest['protocol'], sequence: number): ModelRequest {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = (body.tools ?? []).map((tool: Record<string, any>) => tool.name ?? tool.function?.name).filter((name: unknown): name is string => typeof name === 'string')
  const toolResults = messages.flatMap((message: Record<string, any>) => {
    if (message.role === 'tool') return [{ id: String(message.tool_call_id), text: contentText(message.content), error: false }]
    if (!Array.isArray(message.content)) return []
    return message.content.filter((part: Record<string, any>) => part.type === 'tool_result').map((part: Record<string, any>) => ({ id: String(part.tool_use_id), text: contentText(part.content), error: part.is_error === true }))
  })
  const user = messages.filter((message: Record<string, any>) => message.role === 'user' && contentText(message.content))
  return { sequence, protocol, body, messages, tools, text: messages.map((message: Record<string, any>) => contentText(message.content)).join('\n'), lastUserText: contentText(user.at(-1)?.content), toolResults }
}

async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 24 * 1024 * 1024) throw new Error('Scripted model request exceeds 24 MiB')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function startAcceptanceModel() {
  const exchanges: ModelExchange[] = []
  const errors: string[] = []
  const responses = new Set<ServerResponse>()
  let handler: (request: ModelRequest) => ModelReply | Promise<ModelReply> = request => {
    throw new Error(`No script registered for model request ${request.sequence}`)
  }

  const server = createServer((request, response) => {
    void serve(request, response).catch(error => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      errors.push(message)
      console.error(`[AcceptanceModel] Request failed: ${message}`)
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
      if (!response.writableEnded) response.end(JSON.stringify({ error: { type: 'script_error', message } }))
    })
  })

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method === 'GET' && route.endsWith('/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o', object: 'model', created: 0, owned_by: 'acceptance' }] }))
      return
    }
    if (request.method === 'POST' && route.endsWith('/messages/count_tokens')) {
      await readJson(request)
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 }))
      return
    }
    if (request.method !== 'POST' || (!route.endsWith('/messages') && !route.endsWith('/chat/completions'))) {
      throw new Error(`Unexpected scripted model endpoint: ${request.method} ${route}`)
    }
    const body = await readJson(request)
    const normalized = normalizeRequest(body, route.endsWith('/messages') ? 'anthropic' : 'openai', exchanges.length + 1)
    const exchange: ModelExchange = { request: normalized, startedAt: new Date().toISOString(), completed: false, cancelled: false }
    exchanges.push(exchange)
    const reply = await handler(normalized)
    exchange.reply = { text: reply.text, tools: reply.tools }
    const id = `acceptance-${randomUUID()}`
    const model = String(body.model ?? 'gpt-4o')
    const calls = reply.tools ?? []
    const content = [
      ...(reply.text ? [{ type: 'text', text: reply.text }] : []),
      ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
    ]
    if (!content.length) throw new Error(`Script for request ${normalized.sequence} returned no content`)
    if (body.stream === false) {
      if (reply.hold) throw new Error('A held response requires streaming')
      const message = normalized.protocol === 'anthropic'
        ? { id, type: 'message', role: 'assistant', model, content, stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } }
        : { id, object: 'chat.completion', created: 0, model, choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? null, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
      exchange.completed = true
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message))
      return
    }
    responses.add(response)
    const closed = new Promise<void>(resolve => response.once('close', () => {
      exchange.cancelled = !exchange.completed
      responses.delete(response)
      resolve()
    }))
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    response.flushHeaders()
    const event = (type: string, value: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
    const chunk = (delta: unknown, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
    if (normalized.protocol === 'anthropic') {
      event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
      for (const [index, block] of content.entries()) {
        if (block.type === 'text') {
          event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: (block as { text: string }).text } })
        } else {
          const tool = block as { id: string; name: string; input: unknown }
          event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } })
          event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } })
        }
        event('content_block_stop', { type: 'content_block_stop', index })
      }
    } else {
      chunk({ role: 'assistant', ...(reply.text ? { content: reply.text } : {}) })
      for (const [index, call] of calls.entries()) chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] })
    }
    if (reply.hold) await Promise.race([reply.hold, closed])
    if (response.destroyed) return
    if (normalized.protocol === 'anthropic') {
      event('message_delta', { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
      event('message_stop', { type: 'message_stop' })
    } else {
      chunk({}, calls.length ? 'tool_calls' : 'stop')
      response.write('data: [DONE]\n\n')
    }
    exchange.completed = true
    response.end()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    exchanges,
    errors,
    respond(script: typeof handler) { handler = script },
    async close() {
      for (const response of responses) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

export type AcceptanceModel = Awaited<ReturnType<typeof startAcceptanceModel>>
