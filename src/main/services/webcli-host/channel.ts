import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { MAX_BYTES } from './protocol'

export interface HostRequest { schemaVersion: 1; operation: string; [key: string]: unknown }

export async function createHostChannel(handle: (request: HostRequest) => Promise<unknown>, signal: AbortSignal) {
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const pending = new Set<Promise<void>>()
  let accepting = true
  const reply = (res: ServerResponse, body: unknown, status = 200) => {
    const text = JSON.stringify(body)
    if (Buffer.byteLength(text) > MAX_BYTES) throw Object.assign(new Error('Host response exceeds the size limit.'), { code: 'HOST_PAYLOAD_TOO_LARGE' })
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(text)
  }
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const auth = Buffer.from(req.headers.authorization || '')
    if (!accepting || signal.aborted || req.method !== 'POST' || req.url !== '/webcli/v1'
      || req.headers.origin || req.headers['sec-fetch-site'] || req.headers['content-type'] !== 'application/json'
      || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      console.warn('[WebCLI Host] Rejected request: channel authentication or request contract mismatch')
      reply(res, { schemaVersion: 1, ok: false, error: { code: 'HOST_ACCESS_DENIED', message: 'Host access denied.' } }, 403)
      return
    }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BYTES) throw Object.assign(new Error('Host request exceeds the size limit.'), { code: 'HOST_PAYLOAD_TOO_LARGE' })
        chunks.push(chunk)
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HostRequest
      if (request?.schemaVersion !== 1 || typeof request.operation !== 'string') throw new Error('Invalid host protocol request.')
      signal.throwIfAborted()
      const result = await handle(request)
      signal.throwIfAborted()
      reply(res, { schemaVersion: 1, ok: true, result: result ?? null })
    } catch (error) {
      const code = (error as { code?: string }).code || 'HOST_OPERATION_FAILED'
      console.warn('[WebCLI Host] Request failed', { code })
      if (!res.destroyed && !res.headersSent) reply(res, { schemaVersion: 1, ok: false, error: { code, message: (error as Error).message } })
    }
  }
  const server = createServer((req, res) => {
    const operation = serve(req, res)
    pending.add(operation)
    void operation.finally(() => pending.delete(operation)).catch(() => res.destroy())
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.maxConnections = 8
  const abort = () => { accepting = false; server.closeAllConnections() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (error) {
    signal.removeEventListener('abort', abort)
    server.close()
    throw error
  }
  const address = server.address() as { port: number }
  return {
    endpoint: `http://127.0.0.1:${address.port}/webcli/v1`, token,
    async close() {
      accepting = false
      signal.removeEventListener('abort', abort)
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await Promise.allSettled([...pending])
    },
  }
}
