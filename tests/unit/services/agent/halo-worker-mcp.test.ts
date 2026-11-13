import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkerRuntime } from '@hello-halo/agent-sdk/worker'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '../../../../src/main/services/agent/mcp/sdk-server'

function respond(res: http.ServerResponse, content: Record<string, unknown>[], stop: string) {
  const event = (name: string, value: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  event('message_start', { type: 'message_start', message: { id: 'test-message', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  content.forEach((block, index) => {
    event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
    event('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
    event('content_block_stop', { type: 'content_block_stop', index })
  })
  event('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })
  event('message_stop', { type: 'message_stop' })
  res.end()
}

describe('common MCP server inside the real Halo worker', () => {
  it.each(['eager', 'deferred'] as const)('preserves metadata and executes its host handler across worker RPC with %s loading', async loading => {
    const requests: any[] = []
    const guide = 'Check the selected record before invoking the shared echo tool.'
    const description = 'Shared fixture service for echoing a checked record.'
    const handler = vi.fn(async ({ text }: { text: string }, extra?: unknown) => {
      const signal = (extra as { signal?: AbortSignal })?.signal
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal?.aborted).toBe(false)
      return { content: [{ type: 'text', text: `host:${text}` }] }
    })
    const server = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const message = JSON.parse(body)
      requests.push(message)
      const results = message.messages.flatMap((entry: any) => Array.isArray(entry.content) ? entry.content.filter((block: any) => block.type === 'tool_result') : [])
      const hasResult = results.some((block: any) => block.tool_use_id === 'toolu_worker')
      const discovered = results.some((block: any) => block.tool_use_id === 'toolu_search')
      const next = loading === 'deferred' && !discovered
        ? { type: 'tool_use', id: 'toolu_search', name: 'ToolSearch', input: { query: 'select:mcp__shared__echo' } }
        : { type: 'tool_use', id: 'toolu_worker', name: loading === 'deferred' ? 'CallTool' : 'mcp__shared__echo',
            input: loading === 'deferred' ? { tool: 'mcp__shared__echo', arguments: JSON.stringify({ text: 'hello' }) } : { text: 'hello' } }
      respond(res, hasResult ? [{ type: 'text', text: 'Tool received.' }] : [next], hasResult ? 'end_turn' : 'tool_use')
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const cwd = await mkdtemp(join(tmpdir(), 'halo-worker-mcp-'))
    const runtime = createWorkerRuntime({ warmWorkers: 0, maxWorkers: 1, shutdownTimeoutMs: 1500 })
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 10000)
    try {
      const events: any[] = []
      for await (const event of runtime.query({ prompt: 'Echo hello with the shared tool.', options: {
        cwd, model: 'test-model', persistSession: false, settingSources: [], tools: [], maxTurns: 4,
        env: { HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'config') },
        collaboration: { mode: 'hosted' },
        turnEndChecks: { openWork: false, completion: false },
        toolDiscovery: { services: { shared: { identity: 'fixture:shared', loading } } },
        abortController: controller,
        providerConfig: { type: 'anthropic', apiKey: 'sk-local-test', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
        mcpServers: { shared: createSdkMcpServer({ name: 'shared', description, instructions: guide,
          tools: [tool('echo', 'Echo', { text: z.string() }, handler)] }) as any },
        permissionMode: 'bypassPermissions', canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
      } })) events.push(event)
      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0]).toEqual({ text: 'hello' })
      expect(requests.some(request => JSON.stringify(request.messages).includes('host:hello'))).toBe(true)
      expect(events.some(event => event.type === 'result' && !event.is_error)).toBe(true)
      if (loading === 'deferred') {
        expect(JSON.stringify(requests[0])).toContain(description)
        expect(JSON.stringify(requests[0])).not.toContain(guide)
        expect(requests[0].tools.map((entry: any) => entry.name)).toEqual(['ToolSearch', 'CallTool'])
        expect(JSON.stringify(requests.at(-1).messages).split(guide)).toHaveLength(2)
      } else {
        expect(JSON.stringify(requests[0].system).split(guide)).toHaveLength(2)
        expect(requests[0].tools.map((entry: any) => entry.name)).toContain('mcp__shared__echo')
      }
      for (const request of requests) {
        expect(request.system).toEqual(requests[0].system)
        expect(request.tools).toEqual(requests[0].tools)
      }
    } finally {
      clearTimeout(deadline)
      controller.abort()
      await runtime.close()
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
      await rm(cwd, { recursive: true, force: true })
    }
  }, 15000)
})
