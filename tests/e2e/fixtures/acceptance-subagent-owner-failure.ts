import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const ownerFailureCanary = 'OWNER_CHILD_PROVIDER_REJECTED_400'

export async function ownerFailureEndpoint() {
  const requests: Array<{ path: string; method: string; body: string }> = []
  const server = createServer((incoming, outgoing) => {
    let body = ''
    incoming.setEncoding('utf8')
    incoming.on('data', chunk => { body += chunk })
    incoming.on('end', () => {
      requests.push({ path: incoming.url ?? '', method: incoming.method ?? '', body })
      outgoing.writeHead(400, { 'Content-Type': 'application/json' })
      outgoing.end(JSON.stringify({ error: { type: 'invalid_request_error', message: ownerFailureCanary } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
