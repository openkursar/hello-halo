import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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

const runtimeState = vi.hoisted(() => ({ haloDir: '', routerUrl: '' }))
vi.mock('../../../../../src/main/foundation/config.service', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../src/main/foundation/config.service')>()
  return { ...actual, getHaloDir: () => runtimeState.haloDir }
})
vi.mock('../../../../../src/main/openai-compat-router', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../src/main/openai-compat-router')>()
  return { ...actual, ensureOpenAICompatRouter: async () => ({ baseUrl: runtimeState.routerUrl }) }
})

import { resolveCodexOptions } from '../../../../../src/main/services/agent/codex/options'

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

// Only the model endpoint is scripted; the selected Codex process discovers and runs the tools.
describe.skipIf(!enabled)('Codex native tool routing', () => {
  it.each(['responses', 'chat_completions'] as const)('calls MCP and uses a static CLI skill through a %s model endpoint', async apiType => {
    const codexPath = process.env.HALO_ACCEPTANCE_CODEX_CLI
    if (!codexPath || !path.isAbsolute(codexPath)) throw new Error('CODEX_E2E requires an absolute HALO_ACCEPTANCE_CODEX_CLI executable path')
    const directory = mkdtempSync(path.join(tmpdir(), 'halo-codex-native-'))
    const home = path.join(directory, 'home')
    const workDir = path.join(directory, 'work')
    const name = 'marker-com-example-marker-7f3a9c'
    const skillDir = path.join(home, '.agents', 'skills', name)
    const binDir = path.join(directory, 'cli', 'tools', 'com.example.marker', 'bin')
    const launcher = path.join(binDir, process.platform === 'win32' ? 'cli-e2e-marker.cmd' : 'cli-e2e-marker')
    mkdirSync(workDir)
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Companion skill for the cli-e2e-marker command-line tool. Use the marker command.\n---\n\n- \`cli-e2e-marker\`: \`${launcher}\`\n`)
    if (process.platform === 'win32') {
      writeFileSync(launcher, '@echo native-shell-42\r\n')
    } else {
      writeFileSync(launcher, '#!/bin/sh\nprintf "native-shell-42\\n"\n', { mode: 0o755 })
    }
    const nativeRequests: any[] = []
    const modelRequests: any[] = []
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const prepared = await prepareCodexMcpServers({
      'halo-team': {
        type: 'sdk',
        instance: {
          listTools: () => [{ name: 'spawn_agent', description: 'Return a local marker.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }],
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
      const step = modelRequests.length
      const toolStep = step <= 3
      const toolName = step === 1 ? 'spawn_agent' : 'exec_command'
      const offered = req.body.tools.find((tool: any) => (tool.name ?? tool.function?.name)?.endsWith(toolName))
      const callName = offered?.name ?? offered?.function.name
      const readSkill = process.platform === 'win32'
        ? `Get-Content "$env:USERPROFILE/.agents/skills/${name}/SKILL.md"`
        : `cat "$HOME/.agents/skills/${name}/SKILL.md"`
      const command = step === 2 ? readSkill : `"${launcher}"`
      const args = step === 1 ? { value: 'marker' } : { cmd: command, login: false, max_output_tokens: 200 }
      const callId = `call_native_${modelRequests.length}`
      res.setHeader('Content-Type', 'text/event-stream')
      const send = (event: string, payload: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`) }
      if (apiType === 'responses') {
        const item = toolStep
          ? { type: 'function_call', id: `fc_native_${modelRequests.length}`, call_id: callId, name: callName, arguments: JSON.stringify(args), status: 'completed' }
          : { type: 'message', id: 'msg_native', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Native call completed.', annotations: [] }] }
        const response = { id: `resp_${modelRequests.length}`, object: 'response', created_at: 1, model: req.body.model, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
        send('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
        send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: toolStep ? { ...item, arguments: '' } : item })
        if (toolStep) send('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments })
        send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
        send('response.completed', { type: 'response.completed', response })
      } else {
        const delta = toolStep
          ? { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: callName, arguments: JSON.stringify(args) } }] }
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
    runtimeState.haloDir = directory
    runtimeState.routerUrl = baseUrl(router)
    const resolved = await resolveCodexOptions({
      cwd: workDir,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      apiCredentials: { provider: 'openai', baseUrl: `${baseUrl(upstream)}${endpoint}`, apiKey: 'local-test', model: 'gpt-5.1-codex-max', apiType },
      systemPrompt: { type: 'preset', preset: 'default', append: 'Halo host-context-marker-42' },
      permissionMode: 'bypassPermissions',
    })
    resolved.threadParams.config = { ...resolved.threadParams.config, mcp_servers: prepared.mcpServers }
    const session = new Session({ ...resolved, mcpServers: { 'halo-team': {} }, mcpBridge: prepared.bridge }, 'native-session', {}, {
      path: codexPath, command: codexPath, argsPrefix: [], env: {}, kind: 'native',
    })
    try {
      await (session as any).start()
      session.send('Call spawn_agent with value marker, then finish.')
      const frames: any[] = []
      for await (const frame of session.stream()) frames.push(frame)
      expect(frames.at(-1)).toMatchObject({ type: 'result', is_error: false })
      expect(nativeRequests[0].instructions).toEqual(expect.any(String))
      expect(nativeRequests[0].instructions.length).toBeGreaterThan(100)
      expect(JSON.stringify(nativeRequests[0])).toContain('host-context-marker-42')
      expect(JSON.stringify(modelRequests[0])).toContain('host-context-marker-42')
      expect(resolved.threadParams).not.toHaveProperty('baseInstructions')
      expect(nativeRequests[0].tools.some((tool: any) => tool.type === 'namespace' && tool.tools.some((inner: any) => inner.name === 'spawn_agent'))).toBe(true)
      const nativeTools = nativeRequests[0].tools.flatMap((tool: any) => tool.type !== 'namespace'
        ? [tool.name] : tool.name?.startsWith('mcp__') ? [] : tool.tools.map((entry: any) => entry.name))
      expect(nativeTools).not.toContain('spawn_agent')
      expect(nativeTools).not.toContain('send_input')
      expect(nativeTools).not.toContain('wait_agent')
      expect(calls, JSON.stringify(nativeRequests[0].tools.filter((tool: any) => tool.type === 'namespace'))).toEqual([{ name: 'spawn_agent', args: { value: 'marker' } }])
      expect(JSON.stringify(modelRequests[1])).toContain('native-tool-receipt-42')
      expect(JSON.stringify(modelRequests[1])).not.toContain('unsupported call')
      expect(JSON.stringify(modelRequests[0])).toContain(name)
      expect(JSON.stringify(modelRequests[2])).toContain(JSON.stringify(launcher).slice(1, -1))
      expect(JSON.stringify(modelRequests[3])).toContain('native-shell-42')
      expect(JSON.stringify(modelRequests[3])).not.toContain('unsupported call')
    } finally {
      await session.close()
      await closeServer(router)
      await closeServer(upstream)
      await prepared.bridge?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
