/**
 * A scripted Anthropic Messages endpoint for tests that boot the real dsh
 * runtime. The runtime's DeepSeek adapter speaks Messages (`POST /v1/messages`
 * with an SSE response), so the stub answers in that dialect only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'

export type StubBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export interface StubReply {
  blocks: StubBlock[]
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage?: { input_tokens: number; output_tokens: number }
}

export interface MessagesStub {
  baseUrl: string
  /** Every `/v1/messages` request body, in arrival order. */
  requests: any[]
  /** Headers of every `/v1/messages` request, in arrival order. */
  headers: IncomingMessage['headers'][]
  /** Paths the runtime requested that the stub does not serve. */
  unserved: string[]
  close(): Promise<void>
}

function writeEvent(res: ServerResponse, type: string, data: Record<string, unknown>): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}

function writeReply(res: ServerResponse, reply: StubReply, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const usage = reply.usage ?? { input_tokens: 21, output_tokens: 7 }
  writeEvent(res, 'message_start', {
    message: {
      id: `msg_stub_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
    },
  })
  reply.blocks.forEach((block, index) => {
    if (block.type === 'text') {
      writeEvent(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } })
      writeEvent(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
    } else if (block.type === 'thinking') {
      writeEvent(res, 'content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      writeEvent(res, 'content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } })
      writeEvent(res, 'content_block_delta', { index, delta: { type: 'signature_delta', signature: 'stub-signature' } })
    } else {
      writeEvent(res, 'content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })
      writeEvent(res, 'content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      })
    }
    writeEvent(res, 'content_block_stop', { index })
  })
  writeEvent(res, 'message_delta', {
    delta: { stop_reason: reply.stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  })
  writeEvent(res, 'message_stop', {})
  res.end()
}

/**
 * Start the stub. `script` picks the reply for the n-th Messages request, so a
 * test controls a multi-step turn (tool call, then the reply after its result).
 */
export async function startMessagesStub(script: (requestIndex: number, body: any) => StubReply): Promise<MessagesStub> {
  const requests: any[] = []
  const headers: IncomingMessage['headers'][] = []
  const unserved: string[] = []

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
        unserved.push(`${req.method} ${path}`)
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not served by the stub' } }))
        return
      }
      const body = JSON.parse(raw)
      const index = requests.length
      requests.push(body)
      headers.push(req.headers)
      writeReply(res, script(index, body), body.model ?? 'stub-model')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    headers,
    unserved,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** The single-reply script most cases need. */
export function textReply(text: string): StubReply {
  return { blocks: [{ type: 'text', text }], stopReason: 'end_turn' }
}
