import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface KiroUpstreamRequest {
  sequence: number
  path: string
  body: Record<string, any>
  /** The current user turn as the Kiro payload carries it. */
  currentText: string
  receivedAt: number
}

export type KiroEvent =
  | { event: string; payload: unknown }
  | { exception: string; message: string }

export interface KiroUpstream {
  url: string
  requests: KiroUpstreamRequest[]
  errors: string[]
  respond(handler: (request: KiroUpstreamRequest) => KiroEvent[]): void
  close(): Promise<void>
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One AWS event-stream message: prelude, string headers, payload and both CRCs. */
export function eventStreamFrame(headers: Record<string, string>, payload: unknown): Buffer {
  const headerBuf = Buffer.concat(Object.entries(headers).map(([name, value]) => {
    const nameBuf = Buffer.from(name, 'utf8')
    const valueBuf = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(2)
    length.writeUInt16BE(valueBuf.length)
    return Buffer.concat([Buffer.from([nameBuf.length]), nameBuf, Buffer.from([7]), length, valueBuf])
  }))
  const payloadBuf = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  const prelude = Buffer.alloc(12)
  prelude.writeUInt32BE(12 + headerBuf.length + payloadBuf.length + 4, 0)
  prelude.writeUInt32BE(headerBuf.length, 4)
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8)
  const message = Buffer.concat([prelude, headerBuf, payloadBuf])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(message))
  return Buffer.concat([message, tail])
}

function encode(item: KiroEvent): Buffer {
  if ('exception' in item) return eventStreamFrame({ ':message-type': 'exception', ':exception-type': item.exception }, { message: item.message })
  return eventStreamFrame({ ':message-type': 'event', ':event-type': item.event, ':content-type': 'application/json' }, item.payload)
}

async function readBody(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** A local stand-in for the Kiro generateAssistantResponse endpoint; nothing leaves the machine. */
export async function startKiroUpstream(): Promise<KiroUpstream> {
  const requests: KiroUpstreamRequest[] = []
  const errors: string[] = []
  let handler: (request: KiroUpstreamRequest) => KiroEvent[] = request => {
    throw new Error(`No script registered for Kiro request ${request.sequence}`)
  }

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method !== 'POST') throw new Error(`Unexpected Kiro upstream call: ${request.method} ${path}`)
    const body = await readBody(request)
    const recorded: KiroUpstreamRequest = {
      sequence: requests.length + 1,
      path,
      body,
      currentText: String(body.conversationState?.currentMessage?.userInputMessage?.content ?? ''),
      receivedAt: Date.now(),
    }
    requests.push(recorded)
    const frames = handler(recorded).map(encode)
    response.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream' })
    // Split frames across writes so the decoder must reassemble them.
    const all = Buffer.concat(frames)
    for (let offset = 0; offset < all.length; offset += 13) response.write(all.subarray(offset, offset + 13))
    response.end()
  }

  const server = createServer((request, response) => {
    void serve(request, response).catch(error => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      errors.push(message)
      console.error(`[KiroUpstream] Request failed: ${message}`)
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
      if (!response.writableEnded) response.end(JSON.stringify({ message }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Kiro upstream did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}/generateAssistantResponse`,
    requests,
    errors,
    respond(next) { handler = next },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
