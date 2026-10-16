import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerSession } from '../../../../../src/main/services/agent/codex/session-adapter'
import { prepareCodexMcpServers } from '../../../../../src/main/services/agent/codex/mcp-config'
import { handleResponsesRequest } from '../../../../../src/main/openai-compat-router/server/codex-responses-handler'

vi.mock('../../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (url: string, init: RequestInit) => fetch(url, init),
}))

const enabled = process.env.CODEX_E2E === '1'

async function listen(app: express.Express): Promise<Server> {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  return server
}

function baseUrl(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

// Only the model endpoint is scripted; the bundled Codex process discovers and
// executes the MCP tool through the production bridge and compatibility router.
describe.skipIf(!enabled)('Codex native MCP routing', () => {
  it.each(['responses', 'chat_completions'] as const)('calls a namespaced tool through a %s model endpoint', async apiType => {
    const directory = mkdtempSync(path.join(tmpdir(), 'halo-codex-native-'))
    const codexHome = path.join(directory, 'codex')
    mkdirSync(codexHome)
    const nativeRequests: any[] = []
    const modelRequests: any[] = []
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const prepared = await prepareCodexMcpServers({
      'halo-team': {
        type: 'sdk',
        instance: {
          listTools: () => [{ name: 'collab_start', description: 'Return a local marker.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }],
          callTool: async (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args })
            return { content: [{ type: 'text', text: 'native-tool-receipt-42' }] }
          },
        },
      },
    })
    const upstreamApp = express()
    upstreamApp.use(express.json({ limit: '16mb' }))
    const endpoint = apiType === 'responses' ? '/responses' : '/chat/completions'
    upstreamApp.post(endpoint, (req, res) => {
      modelRequests.push(req.body)
      const toolStep = modelRequests.length <= 2
      const toolName = modelRequests.length === 1 ? 'collab_start' : 'exec_command'
      const offered = req.body.tools.find((tool: any) => (tool.name ?? tool.function?.name)?.endsWith(toolName))
      const name = offered?.name ?? offered?.function.name
      const args = modelRequests.length === 1 ? { value: 'marker' } : { cmd: 'printf native-shell-%s $((6 * 7))', max_output_tokens: 100 }
      const callId = `call_native_${modelRequests.length}`
      res.setHeader('Content-Type', 'text/event-stream')
      const send = (event: string, payload: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`) }
      if (apiType === 'responses') {
        const item = toolStep
          ? { type: 'function_call', id: `fc_native_${modelRequests.length}`, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' }
          : { type: 'message', id: 'msg_native', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Native call completed.', annotations: [] }] }
        const response = { id: `resp_${modelRequests.length}`, object: 'response', created_at: 1, model: req.body.model, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
        send('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
        send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: toolStep ? { ...item, arguments: '' } : item })
        if (toolStep) send('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments })
        send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
        send('response.completed', { type: 'response.completed', response })
      } else {
        const delta = toolStep
          ? { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
          : { role: 'assistant', content: 'Native call completed.' }
        const chunk = { id: 'chat_native', object: 'chat.completion.chunk', created: 1, model: req.body.model }
        res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: toolStep ? 'tool_calls' : 'stop' }] })}\n\n`)
        res.write('data: [DONE]\n\n')
      }
      res.end()
    })
    const upstream = await listen(upstreamApp)
    const routerApp = express()
    routerApp.use(express.json({ limit: '16mb' }))
    routerApp.post('/v1/responses', (req, res) => {
      nativeRequests.push(req.body)
      void handleResponsesRequest(req.body, { url: `${baseUrl(upstream)}${endpoint}`, key: 'local-test', model: 'gpt-5.1-codex-max', apiType }, res)
    })
    const router = await listen(routerApp)
    const Session = CodexAppServerSession as unknown as new (...args: any[]) => CodexAppServerSession
    const session = new Session({
      env: { ...process.env, CODEX_HOME: codexHome, HALO_NATIVE_TEST_KEY: 'local-test' },
      cwd: directory, model: 'gpt-5.1-codex-max', displayModel: 'gpt-5.1-codex-max',
      includePartialMessages: true, mcpServers: { 'halo-team': {} }, mcpBridge: prepared.bridge,
      threadParams: {
        model: 'gpt-5.1-codex-max', cwd: directory, approvalPolicy: 'never', sandbox: 'danger-full-access',
        config: {
          model_provider: 'local-test',
          model_providers: { 'local-test': { name: 'Local deterministic model', base_url: `${baseUrl(router)}/v1`, wire_api: 'responses', requires_openai_auth: false, env_key: 'HALO_NATIVE_TEST_KEY' } },
          mcp_servers: prepared.mcpServers,
        },
      },
    }, 'native-session', {})
    try {
      await (session as any).start()
      session.send('Call collab_start with value marker, then finish.')
      const frames: any[] = []
      for await (const frame of session.stream()) frames.push(frame)
      expect(frames.at(-1)).toMatchObject({ type: 'result', is_error: false })
      expect(nativeRequests[0].tools.some((tool: any) => tool.type === 'namespace' && tool.tools.some((inner: any) => inner.name === 'collab_start'))).toBe(true)
      expect(calls, JSON.stringify(nativeRequests[0].tools.filter((tool: any) => tool.type === 'namespace'))).toEqual([{ name: 'collab_start', args: { value: 'marker' } }])
      expect(JSON.stringify(modelRequests[1])).toContain('native-tool-receipt-42')
      expect(JSON.stringify(modelRequests[1])).not.toContain('unsupported call')
      expect(JSON.stringify(modelRequests[2])).toContain('native-shell-42')
      expect(JSON.stringify(modelRequests[2])).not.toContain('unsupported call')
    } finally {
      await session.close()
      await closeServer(router)
      await closeServer(upstream)
      await prepared.bridge?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
