import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createSession, createSdkMcpServer, tool,
  type Options, type SDKSession, type LlmProvider, type ProviderRequest, type StreamEvent,
} from '@hello-halo/agent-sdk'
import { applyCapabilityPolicy } from '../../../../src/main/apps/runtime/capability-policy'
import { beginDelegatedTurn, clearDelegation, createDelegationAuditHooks, decideDelegatedTool } from '../../../../src/main/apps/runtime/delegation-gate'
import { createCanUseTool } from '../../../../src/main/services/agent/permission-handler'
import { buildToolDiscoveryOptions, markInstalledMcpContext } from '../../../../src/main/services/agent/tool-discovery'
import type { InstalledApp } from '../../../../src/shared/apps/app-types'
import type { TeamToolAudit } from '../../../../src/shared/apps/team-types'

vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
const sessions: SDKSession[] = []
const directories: string[] = []
const conversationId = 'delegated-discovery'
afterEach(async () => {
  clearDelegation(conversationId)
  for (const session of sessions.splice(0)) await session.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture(mode: 'strict' | 'permissive', disallowedTools: string[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), 'halo-delegated-discovery-'))
  directories.push(cwd)
  const allowed = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Allowed customer receipt' }] }))
  const withheld = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Private customer receipt' }] }))
  const schema = { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }
  const server = (name: string, handler: typeof allowed) => markInstalledMcpContext(createSdkMcpServer({ name, tools: [
    tool('lookup', name === 'private' ? 'Withheld private customer definition.' : 'Find an allowed customer.', schema, handler),
  ] }), { id: name, spec: { type: 'mcp', description: `${name} customer service` }, userOverrides: {} } as InstalledApp)
  const offered = { crm: server('crm', allowed), private: server('private', withheld) }
  const policy = { allowedTools: [], allowedUserMcp: ['crm'] }
  const permissions: string[] = []
  const audit: TeamToolAudit[] = []
  const requests: ProviderRequest[] = []
  const provider: LlmProvider = {
    id: 'delegation-fixture', name: 'Delegation fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false,
      audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    createMessage: async () => { throw new Error('Unexpected nonstreaming fixture request') },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const index = requests.length
      requests.push(structuredClone(request))
      const call = index === 0
        ? { type: 'tool_use' as const, id: 'find', name: 'ToolSearch', input: { query: 'lookup' } }
        : index === 1
          ? { type: 'tool_use' as const, id: 'allowed-call', name: 'CallTool', input: { tool: 'mcp__crm__lookup', arguments: '{"customer":"42"}' } }
          : index === 2
            ? { type: 'tool_use' as const, id: 'withheld-call', name: 'CallTool', input: { tool: 'mcp__private__lookup', arguments: '{"customer":"42"}' } }
            : undefined
      yield { type: 'message_start', id: `response-${index}`, model: request.model, usage: { input_tokens: 0, output_tokens: 0 } }
      yield { type: 'content_block_start', index: 0, content_block: call ? { ...call, input: {} } : { type: 'text', text: 'Done.' } }
      if (call) yield { type: 'input_json_delta', index: 0, partialJson: JSON.stringify(call.input) }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', stopReason: call ? 'tool_use' : 'end_turn' }
      yield { type: 'message_stop' }
    },
  }
  const options: Options = {
    cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'records') }, model: 'fixture', provider,
    tools: [], settingSources: [], persistSession: false, systemPrompt: 'Use only the granted customer service.',
    disallowedTools, maxTurns: 8, turnEndChecks: { completion: false, openWork: false },
    canUseTool: createCanUseTool({ spaceId: 'space', conversationId, nonInteractive: true,
      gate: (name, input) => { permissions.push(name); return decideDelegatedTool(conversationId, name, input) } }),
  }
  applyCapabilityPolicy(options, { policy, mode, mcpServers: offered, dbMcpServers: offered })
  options.toolDiscovery = buildToolDiscoveryOptions(options.mcpServers)
  options.hooks = createDelegationAuditHooks(conversationId) as Options['hooks']
  beginDelegatedTurn(conversationId, { policy, mode, clientToolDiscovery: true,
    audit: { teamId: 'team', epochId: 'turn', appId: 'worker', actorAppId: null, external: true, sink: entry => audit.push(entry) } })
  return { options, allowed, withheld, requests, permissions, audit }
}

describe('deferred tools under actual Halo delegated permissions', () => {
  it.each(['strict', 'permissive'] as const)('lets a %s borrowed turn discover only its allowed service and executes through its real gate', async mode => {
    const run = await fixture(mode)
    expect(Object.keys(run.options.mcpServers!)).toEqual(['crm'])
    const session = await createSession(run.options)
    sessions.push(session)
    await session.send('Find the allowed customer.')
    for await (const frame of session.stream()) if (frame.type === 'result') break
    expect(run.allowed).toHaveBeenCalledOnce()
    expect(run.withheld).not.toHaveBeenCalled()
    expect(run.permissions).toEqual(['ToolSearch', 'mcp__crm__lookup'])
    expect(run.audit.map(entry => entry.toolName)).toEqual(['ToolSearch', 'mcp__crm__lookup'])
    expect(run.requests[0].tools?.map(item => item.name)).toEqual(['ToolSearch', 'CallTool'])
    expect(JSON.stringify(run.requests)).not.toContain('Withheld private customer definition')
    expect(JSON.stringify(run.requests[1])).toContain('Find an allowed customer')
    expect(JSON.stringify(run.requests[2])).toContain('Allowed customer receipt')
  })

  it('preserves an explicit ToolSearch prohibition instead of overriding it for a guest', async () => {
    const run = await fixture('strict', ['ToolSearch'])
    expect(run.options.disallowedTools).toContain('ToolSearch')
    await expect(createSession(run.options)).rejects.toThrow(/ToolSearch.*disabled|entry is disabled/)
    expect(run.permissions).toEqual([])
    expect(run.allowed).not.toHaveBeenCalled()
  })
})
