import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test as base, expect } from '@playwright/test'
import type { ContentBlock, LlmProvider, Options, ProviderRequest, SDKMessage, SDKSession, StreamEvent } from '@hello-halo/agent-sdk'

type Sdk = typeof import('@hello-halo/agent-sdk')
const test = base.extend<{ sdk: Sdk; profile: string }>({
  sdk: async ({}, use) => { await use(await import('@hello-halo/agent-sdk')) },
  profile: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'halo-tool-discovery-acceptance-'))
    try { await use(profile) } finally { await rm(profile, { recursive: true, force: true }) }
  },
})
test.setTimeout(30000)

const target = 'mcp__records__lookup'
const secondary = 'mcp__records__notes'
const definitionText = 'Read the complete customer order record with its delivery receipt.'
const guide = 'Use the selected account reference for every lookup.'
const rawArguments = '{ "account" : "customer-42" }'
const schema = { type: 'object', properties: { account: { type: 'string', description: 'The selected account reference.' } }, required: ['account'], additionalProperties: false }
const done: ContentBlock = { type: 'text', text: 'The requested work is complete.' }
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input })
const search = (id = 'search-lookup', name = target) => use(id, 'ToolSearch', { query: `select:${name}` })
const invoke = (id = 'call-lookup', name = target) => use(id, 'CallTool', { tool: name, arguments: rawArguments })
const binding = (caseId: string, variant: Record<string, string> = {}) => ({
  annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'integration', mode: 'scripted', variant }) },
})

function scripted(replies: ContentBlock[][]) {
  const requests: ProviderRequest[] = []
  const summaries: ProviderRequest[] = []
  const snapshot = (request: ProviderRequest): ProviderRequest => ({ ...request, providerOptions: undefined,
    messages: structuredClone(request.messages), tools: structuredClone(request.tools), systemPrompt: structuredClone(request.systemPrompt) })
  const provider: LlmProvider = {
    id: 'local-discovery-script', name: 'Local discovery script',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false,
      audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    createMessage: async request => {
      summaries.push(snapshot(request))
      return { id: randomUUID(), model: request.model, content: [{ type: 'text', text: 'Continue the task using the verified constraints.' }],
        stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }
    },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const content = replies[requests.length] ?? [done]
      requests.push(snapshot(request))
      yield { type: 'message_start', id: randomUUID(), model: request.model, usage: { input_tokens: 0, output_tokens: 0 } }
      for (const [index, block] of content.entries()) {
        yield { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block }
        if (block.type === 'tool_use') {
          const json = JSON.stringify(block.input)
          yield { type: 'input_json_delta', index, partialJson: json.slice(0, 9) }
          yield { type: 'input_json_delta', index, partialJson: json.slice(9) }
        }
        yield { type: 'content_block_stop', index }
      }
      yield { type: 'message_delta', stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' }
      yield { type: 'message_stop' }
    },
  }
  return { provider, requests, summaries }
}

function fixture(sdk: Sdk, profile: string, provider: LlmProvider, settings: {
  options?: Partial<Options>; description?: string; resultSize?: number
} = {}) {
  const effects: Array<{ tool: string; account: unknown }> = []
  const options: Options = {
    model: 'discovery-fixture', provider, cwd: profile, tools: [], settingSources: [],
    env: { HOME: profile, USERPROFILE: profile, CLAUDE_CONFIG_DIR: join(profile, 'sdk-state') },
    conventions: { memoryFiles: [], memorySubdirs: [], agentDirs: [] },
    systemPrompt: 'Keep the user constraints. Use the connected service for requested records.',
    toolCallingMode: 'native', thinking: { type: 'disabled' }, maxOutputTokens: 1024,
    contextWindow: 32000, maxTurns: 20, toolResultBudget: 20000,
    permissionMode: 'default', canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    turnEndChecks: { openWork: false, completion: false },
    mcpServers: { records: sdk.createSdkMcpServer({ name: 'records', instructions: guide, tools: ['lookup', 'notes'].map(name =>
      sdk.tool(name, name === 'lookup' ? settings.description ?? definitionText : 'Read customer notes.', schema, async (input: Record<string, unknown>) => {
        effects.push({ tool: name, account: input.account })
        return { content: [{ type: 'text', text: `Receipt for ${name}: ${input.account}. ${'Observed record evidence. '.repeat(settings.resultSize ?? 1)}` }] }
      })) }) },
    toolDiscovery: { services: { records: { identity: 'fixture-installation', loading: 'deferred', summary: 'Customer orders and notes' } } },
    ...settings.options,
  }
  return { options, effects }
}

async function collect(stream: AsyncIterable<SDKMessage>) {
  const events: SDKMessage[] = []
  for await (const event of stream) { events.push(event); if (event.type === 'result') break }
  expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false })
  return events
}
async function send(session: SDKSession, text: string) { await session.send(text); return collect(session.stream()) }
const blocks = (request: ProviderRequest) => request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
function result(request: ProviderRequest, id: string) {
  const found = blocks(request).find(block => block.type === 'tool_result' && block.tool_use_id === id)
  expect(found?.type).toBe('tool_result')
  if (!found || found.type !== 'tool_result') throw new Error(`Missing tool result ${id}`)
  return found
}

for (const entry of ['session', 'query'] as const) for (const permission of ['allow', 'deny'] as const) {
  test(`${entry} keeps fixed tool declarations and applies real-tool permission ${permission}`,
    binding('capabilities.tool-discovery.fixed-request', { entry, permission }), async ({ sdk, profile }, info) => {
      const script = scripted([[search()], [search('search-notes', secondary)], [invoke()], [done]])
      const permissionNames: string[] = []
      const { options, effects } = fixture(sdk, profile, script.provider, { options: {
        persistSession: entry === 'session', allowedTools: ['CallTool'],
        canUseTool: async name => {
          permissionNames.push(name)
          if (name === target) return permission === 'deny'
            ? { behavior: 'deny', message: 'The fixture account is unavailable to this caller.' }
            : { behavior: 'allow', updatedInput: { account: 'approved-account' } }
          return { behavior: 'allow', updatedInput: {} }
        },
      } })
      let session: SDKSession | undefined
      try {
        const events = entry === 'query' ? await collect(sdk.query({ prompt: 'Find the requested customer record.', options }))
          : await send(session = await sdk.createSession(options), 'Find the requested customer record.')
        expect(script.requests).toHaveLength(4)
        const first = script.requests[0]
        expect(first.tools?.map(tool => tool.name)).toEqual(['ToolSearch', 'CallTool'])
        expect(JSON.stringify(first)).not.toContain(definitionText)
        expect(JSON.stringify(first)).not.toContain(guide)
        const found = JSON.parse(String(result(script.requests[1], 'search-lookup').content))
        expect(found.tools).toContainEqual(expect.objectContaining({ name: target, description: definitionText, input_schema: schema, usage_guide: guide }))
        for (let index = 0; index < script.requests.length; index++) {
          const request = script.requests[index]
          expect(request.tools).toEqual(first.tools)
          expect(request.systemPrompt).toEqual(first.systemPrompt)
          expect(JSON.stringify(request)).not.toMatch(/"toolContext"|"halo_defer_loading"|"defer_loading"/)
          if (index) expect(request.messages.slice(0, script.requests[index - 1].messages.length)).toEqual(script.requests[index - 1].messages)
        }
        expect(blocks(script.requests[3])).toContainEqual(invoke())
        expect(permissionNames).toContain(target)
        expect(effects).toEqual(permission === 'allow' ? [{ tool: 'lookup', account: 'approved-account' }] : [])
        expect(result(script.requests[3], 'call-lookup').is_error ?? false).toBe(permission === 'deny')
        const visibleNames = events.flatMap(event => event.type === 'assistant' ? event.message.content : [])
          .filter(block => block.type === 'tool_use').map(block => block.name)
        expect(visibleNames).toContain(target)
        expect(visibleNames).not.toContain('CallTool')
        await info.attach('discovery-boundary', { body: JSON.stringify({ entry, permission, effects, permissionNames,
          requests: script.requests.map(request => ({ tools: request.tools?.map(tool => tool.name), messageCount: request.messages.length })) }), contentType: 'application/json' })
      } finally { await session?.close() }
    })
}

test('compaction and reopening retain discovered definitions even when every summary omits them',
  binding('capabilities.tool-discovery.compact-resume'), async ({ sdk, profile }, info) => {
    const script = scripted([[search()], ...Array.from({ length: 8 }, (_, index) => [invoke(`lookup-${index}`)]), [done]])
    const { options, effects } = fixture(sdk, profile, script.provider, { resultSize: 220,
      options: { persistSession: true, contextWindow: 9000, maxOutputTokens: 512, toolResultBudget: 6000 } })
    const session = await sdk.createSession(options)
    let restored: SDKSession | undefined
    try {
      const events = await send(session, 'Collect the requested records and keep the original constraints.')
      expect(script.summaries.length).toBeGreaterThan(0)
      expect(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true)
      expect(effects).toHaveLength(8)
      for (const request of script.requests) expect(request.tools).toEqual(script.requests[0].tools)
      await session.close()
      const files = await readdir(profile, { recursive: true })
      const path = join(profile, files.find(file => file.endsWith(`${session.sessionId}.jsonl`))!)
      const before = await readFile(path, 'utf8')
      expect(before).toContain('compact_checkpoint')
      const resumed = scripted([[invoke('after-reopen')], [done]])
      restored = await sdk.createSession({ ...options, provider: resumed.provider, resume: session.sessionId, strictResume: true })
      await send(restored, 'Use the already discovered lookup again.')
      expect(resumed.summaries).toEqual([])
      expect(resumed.requests).toHaveLength(2)
      expect(effects).toHaveLength(9)
      expect(resumed.requests[0].tools).toEqual(script.requests[0].tools)
      const restoredText = resumed.requests[0].messages.map(message => typeof message.content === 'string'
        ? message.content : message.content.flatMap(block => block.type === 'tool_result' && typeof block.content === 'string' ? [block.content] : [])).flat().join('\n')
      expect(restoredText).toContain(definitionText)
      expect(restoredText).toContain(JSON.stringify(schema))
      expect(restoredText).toContain(guide)
      await restored.close()
      expect((await readFile(path, 'utf8')).startsWith(before)).toBe(true)
      await info.attach('discovery-recovery', { body: JSON.stringify({ summaries: script.summaries.length,
        completedCallsBeforeReopen: 8, completedCallsAfterReopen: effects.length, resumedRequests: resumed.requests.length,
        originalJournalPrefixPreserved: true }), contentType: 'application/json' })
    } finally { await restored?.close(); await session.close() }
  })

for (const boundary of ['before-discovery', 'after-discovery'] as const) {
  test(`forking ${boundary} restores only that prefix and isolates later discoveries`,
    binding('capabilities.tool-discovery.fork', { boundary }), async ({ sdk, profile }) => {
      const originalScript = scripted([[done], [search()], [done]])
      const { options, effects } = fixture(sdk, profile, originalScript.provider, { options: { persistSession: true } })
      const original = await sdk.createSession(options)
      let branch: SDKSession | undefined
      let parent: SDKSession | undefined
      try {
        const earlier = await send(original, 'Keep this initial request.')
        const later = await send(original, 'Find the lookup tool without running it.')
        const events = boundary === 'before-discovery' ? earlier : later
        const anchor = events.filter(event => event.type === 'assistant').at(-1)!.uuid
        await original.close()
        const fork = await sdk.forkSession(original.sessionId, { cwd: profile, env: options.env, upToMessageId: anchor })
        expect(fork.sessionId).not.toBe(original.sessionId)
        const branchScript = scripted([[invoke('branch-lookup')], [search('branch-notes-search', secondary)], [invoke('branch-notes', secondary)], [done]])
        branch = await sdk.createSession({ ...options, provider: branchScript.provider, resume: fork.sessionId, strictResume: true })
        await send(branch, 'Use lookup, then find and read notes in this branch.')
        expect(result(branchScript.requests[1], 'branch-lookup').is_error ?? false).toBe(boundary === 'before-discovery')
        expect(effects.filter(effect => effect.tool === 'lookup')).toHaveLength(boundary === 'before-discovery' ? 0 : 1)
        expect(effects.filter(effect => effect.tool === 'notes')).toHaveLength(1)
        await branch.close()
        const parentScript = scripted([[invoke('parent-notes', secondary)], [invoke('parent-lookup')], [done]])
        parent = await sdk.createSession({ ...options, provider: parentScript.provider, resume: original.sessionId, strictResume: true })
        await send(parent, 'Try notes, then use the parent lookup.')
        expect(result(parentScript.requests[1], 'parent-notes').is_error).toBe(true)
        expect(result(parentScript.requests[2], 'parent-lookup').is_error ?? false).toBe(false)
        expect(effects.filter(effect => effect.tool === 'notes')).toHaveLength(1)
        expect(effects.filter(effect => effect.tool === 'lookup')).toHaveLength(boundary === 'before-discovery' ? 1 : 2)
      } finally { await parent?.close(); await branch?.close(); await original.close() }
    })
}

for (const budget of ['bytes', 'characters', 'recovery'] as const) {
  test(`a definition beyond the ${budget} budget is not partially delivered or granted`,
    binding('capabilities.tool-discovery.budget', { budget }), async ({ sdk, profile }) => {
      const script = scripted([[search()], [invoke()], [done]])
      const { options, effects } = fixture(sdk, profile, script.provider, {
        description: budget === 'bytes' ? '界'.repeat(12000) : budget === 'recovery' ? 'x'.repeat(24000) : definitionText,
        options: { toolResultBudget: budget === 'characters' ? 256 : 30000,
          ...(budget === 'recovery' ? { contextWindow: 4096, maxOutputTokens: 512 } : {}) },
      })
      const session = await sdk.createSession(options)
      try {
        await send(session, 'Find the service tool and try the requested lookup.')
        expect(script.requests).toHaveLength(3)
        const found = JSON.parse(String(result(script.requests[1], 'search-lookup').content))
        expect(found.tools).toEqual([])
        expect(found.notice).toContain('did not fit')
        expect(result(script.requests[2], 'call-lookup').is_error).toBe(true)
        expect(effects).toEqual([])
        expect(script.requests[2].tools).toEqual(script.requests[0].tools)
      } finally { await session.close() }
    })
}
