import { createServer } from 'node:http'

export async function startAcceptanceMcp() {
  let available = true
  let failTools = false
  const requests: Array<{ method: string; status: number }> = []
  const calls: Array<{ value: string; failed: boolean }> = []
  const server = createServer((request, response) => {
    void (async () => {
      if (!available) {
        requests.push({ method: 'unavailable', status: 503 })
        response.writeHead(503, { 'Content-Type': 'text/plain' }).end('Acceptance MCP service unavailable')
        return
      }
      if (request.method === 'GET') { response.writeHead(405).end(); return }
      if (request.method === 'DELETE') { response.writeHead(200).end(); return }
      if (request.method !== 'POST' || request.url !== '/mcp') throw new Error(`Unexpected MCP endpoint: ${request.method} ${request.url}`)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: string | number; method: string; params?: Record<string, any> }
      if (message.id === undefined) { response.writeHead(202).end(); return }
      let result: unknown
      switch (message.method) {
        case 'initialize':
          result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'acceptance-echo', version: '1.0.0' } }
          break
        case 'ping': result = {}; break
        case 'tools/list':
          result = { tools: [{ name: 'echo_acceptance', description: 'Return the supplied acceptance value.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] }
          break
        case 'tools/call': {
          if (message.params?.name !== 'echo_acceptance' || typeof message.params.arguments?.value !== 'string') throw new Error('Unexpected acceptance MCP tool arguments')
          const value = message.params.arguments.value as string
          calls.push({ value, failed: failTools })
          result = { content: [{ type: 'text', text: failTools ? 'The requested service operation failed. No result was produced.' : `Service receipt: ${value}` }], isError: failTools }
          break
        }
        default:
          requests.push({ method: message.method, status: 200 })
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }))
          return
      }
      requests.push({ method: message.method, status: 200 })
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })().catch(error => {
      console.error('[AcceptanceMcp] Protocol request failed:', error)
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' })
      response.end('Acceptance MCP protocol error')
    })
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    requests,
    calls,
    setAvailable(value: boolean) { available = value },
    failTools(value: boolean) { failTools = value },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    },
  }
}
