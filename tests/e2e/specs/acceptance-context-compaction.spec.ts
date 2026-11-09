import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test as base, expect } from '@playwright/test'
import type {
  ContentBlock, LlmProvider, Message, Options, ProviderRequest, ProviderResponse,
  SDKMessage, SDKResultMessage, SDKSession, StreamEvent, Tool, UsageInfo,
} from '@hello-halo/agent-sdk'
import { createModelGate } from '../fixtures/acceptance-model'

type Sdk = typeof import('@hello-halo/agent-sdk')
type Reply = { content: ContentBlock[]; usage?: UsageInfo }
type Exchange = { kind: 'summary' | 'answer'; request: ProviderRequest }
const model = 'scripted-context-model'
const summary = 'Earlier work established the fixture constraints. Continue the pending request without repeating completed actions.'
const systemPrompt = 'Keep the original project constraints. '.repeat(20)
const summaryUsage = { input_tokens: 91, output_tokens: 23, cache_creation_input_tokens: 11, cache_read_input_tokens: 17 }
const answerUsage = { input_tokens: 37, output_tokens: 13, cache_creation_input_tokens: 3, cache_read_input_tokens: 5 }
const prices = { inputPerMtk: 2, outputPerMtk: 5, cacheCreationPerMtk: 3, cacheReadPerMtk: 1 }

const test = base.extend<{ sdk: Sdk; profile: string }>({
  sdk: async ({}, use) => {
    // Runtime imports resolve the package's built public entry, never SDK internals.
    await use(await import('@hello-halo/agent-sdk'))
  },
  profile: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'halo-context-acceptance-'))
    try { await use(profile) } finally { await rm(profile, { recursive: true, force: true }) }
  },
})
test.setTimeout(30000)

const cacheCaseIds = [
  'append-small', 'append-200k-large-output', 'compact-reported', 'compact-absent', 'compact-zero', 'compact-output-only',
  'compact-low-output', 'compact-thinking-clamped', 'recovery-empty', 'recovery-truncated', 'recovery-tool-use',
  'recovery-retry', 'recovery-overflow', 'recovery-checkpoint', 'recovery-cancel', 'arrivals', 'resume', 'concurrent-isolation',
  'wire-negative-history', 'wire-negative-marker', 'summary-merge', 'fixed-capacity', 'output-exhausted', 'child-agent', 'arrivals-across-compaction', 'configuration-switch', 'skill-mcp', 'breakpoint-envelope',
]
for (const scenario of cacheCaseIds) {
  test(`offline wire cache regression: ${scenario}`, {
    annotation: binding('chat.execution.cache-wire', { scenario }),
  }, async ({ sdk }, info) => {
    const fixture = pathToFileURL(join(process.cwd(), 'src/sdk/halo-sdk/validation/cache-scenarios.mjs')).href
    const { runCacheCase, cacheCases } = await import(fixture)
    expect(cacheCases('fast').map((item: { id: string }) => item.id).sort()).toEqual([...cacheCaseIds].sort())
    let detail: unknown
    try {
      const result = await runCacheCase(sdk, scenario, { emit: (value: unknown) => { detail = value } })
      expect(result.passed).toBe(true)
    } finally {
      await info.attach('offline-cache-evidence', { body: JSON.stringify(detail ?? { scenario, incomplete: true }), contentType: 'application/json' })
    }
  })
}

function binding(caseId: string, variant: Record<string, string> = {}) {
  return { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'integration', mode: 'scripted', variant }) }
}

function options(profile: string): Options {
  return {
    model, cwd: profile, contextWindow: 12000, maxOutputTokens: 2000, maxTurns: 4,
    systemPrompt, tools: [], toolCallingMode: 'native', thinking: { type: 'disabled' },
    toolResultBudget: 1000000, turnEndChecks: { openWork: false, completion: false },
    settingSources: [], conventions: { memoryFiles: [], memorySubdirs: [], agentDirs: [] },
    env: { HOME: profile, USERPROFILE: profile, CLAUDE_CONFIG_DIR: join(profile, 'config') },
    modelPricing: { [model]: prices },
  }
}

function snapshot(request: ProviderRequest): ProviderRequest {
  return { ...request, messages: structuredClone(request.messages),
    systemPrompt: structuredClone(request.systemPrompt), tools: structuredClone(request.tools) }
}

function scriptedProvider(
  answer: (request: ProviderRequest, index: number) => Reply,
  summarize: (request: ProviderRequest) => Reply | Promise<Reply> = () => ({ content: [{ type: 'text', text: summary }], usage: summaryUsage }),
) {
  const exchanges: Exchange[] = []
  let answers = 0
  const provider: LlmProvider = {
    id: 'local-context-script', name: 'Local context script',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage(request) {
      exchanges.push({ kind: 'summary', request: snapshot(request) })
      const reply = await summarize(request)
      // Missing usage deliberately models a provider which supplies no accounting.
      return { id: randomUUID(), model, content: reply.content,
        stopReason: reply.content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        ...(reply.usage ? { usage: reply.usage } : {}),
      } as ProviderResponse
    },
    async *createMessageStream(request) {
      exchanges.push({ kind: 'answer', request: snapshot(request) })
      const reply = answer(request, answers++)
      yield { type: 'message_start', id: randomUUID(), model,
        ...(reply.usage ? { usage: { ...reply.usage, output_tokens: 0 } } : {}),
      } as StreamEvent
      for (const [index, block] of reply.content.entries()) {
        yield { type: 'content_block_start', index, content_block: block }
        yield { type: 'content_block_stop', index }
      }
      yield { type: 'message_delta', stopReason: reply.content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        ...(reply.usage ? { usage: { output_tokens: reply.usage.output_tokens } } : {}),
      }
      yield { type: 'message_stop' }
    },
  }
  return { provider, exchanges }
}

function fixtureTool(content: string, executed: string[]): Tool {
  return {
    name: 'FixtureRead', description: 'Read the isolated fixture without changing user files. '.repeat(6),
    inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
    permissionLevel: 'none',
    async execute(input) { executed.push(String(input.label)); return { content, isError: false } },
  }
}

function toolCall(label: string): ContentBlock {
  return { type: 'tool_use', id: `fixture-${label}`, name: 'FixtureRead', input: { label } }
}

function compactHistory(): Message[] {
  const history: Message[] = []
  for (let index = 0; index < 8; index++) {
    history.push({ role: 'user', content: `Original request ${index}: ${'u'.repeat(1200)}` })
    history.push({ role: 'assistant', content: `Original answer ${index}: ${'a'.repeat(1200)}` })
  }
  history.push({ role: 'user', content: 'Read the remaining fixture and finish the pending work.' })
  return history
}

async function collect(stream: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const events: SDKMessage[] = []
  for await (const event of stream) events.push(event)
  return events
}

function resultOf(events: SDKMessage[]): SDKResultMessage {
  const results = events.filter((event): event is SDKResultMessage => event.type === 'result')
  expect(results).toHaveLength(1)
  return results[0]
}

function compactEvents(events: SDKMessage[]) {
  return events.filter(event => event.type === 'system' && event.subtype === 'compact_boundary')
}

function cost(usage: UsageInfo): number {
  return (usage.input_tokens * prices.inputPerMtk + usage.output_tokens * prices.outputPerMtk +
    (usage.cache_creation_input_tokens ?? 0) * prices.cacheCreationPerMtk +
    (usage.cache_read_input_tokens ?? 0) * prices.cacheReadPerMtk) / 1000000
}

for (const usage of ['reported', 'absent'] as const) {
  test(`ordinary history remains append-only with ${usage} usage`, {
    annotation: binding('chat.execution.append-only-context', { usage }),
  }, async ({ sdk, profile }, info) => {
    const history: Message[] = [{ role: 'user', content: 'Retain all original tool observations.' }]
    for (let index = 0; index < 5; index++) {
      history.push({ role: 'assistant', content: [toolCall(`old-${index}`)] })
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `fixture-old-${index}`, content: `${index}:${'original observation '.repeat(600)}` }] })
    }
    history.push({ role: 'user', content: 'Check one more item and finish.' })
    const original = structuredClone(history)
    const executed: string[] = []
    const script = scriptedProvider((_request, index) => ({
      content: index === 0 ? [toolCall('next')] : [{ type: 'text', text: 'Finished without clearing earlier observations.' }],
      ...(usage === 'reported' ? { usage: { input_tokens: 82000, output_tokens: 10 } } : {}),
    }))
    const config = sdk.resolveQueryConfig({ ...options(profile), contextWindow: 100000, maxOutputTokens: 1000, toolResultBudget: 128 })
    const events = await collect(sdk.queryLoop(config, script.provider, [fixtureTool('new observation', executed)], history))
    expect(resultOf(events)).toMatchObject({ is_error: false })
    expect(compactEvents(events)).toEqual([])
    expect(script.exchanges.map(exchange => exchange.kind)).toEqual(['answer', 'answer'])
    const [first, second] = script.exchanges.map(exchange => exchange.request)
    expect(first.messages.slice(-original.length)).toEqual(original)
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(second.systemPrompt).toEqual(first.systemPrompt)
    expect(second.tools).toEqual(first.tools)
    expect(executed).toEqual(['next'])
    await info.attach('append-only-context', { body: JSON.stringify({ usage, originalMessages: original.length, requestMessages: [first.messages.length, second.messages.length], result: resultOf(events) }), contentType: 'application/json' })
  })

  test(`summarize before the next request and account only for ${usage} usage`, {
    annotation: [binding('chat.execution.pre-request-summary', { usage }), binding('chat.usage.compaction-accounting', { usage })],
  }, async ({ sdk, profile }, info) => {
    const executed: string[] = []
    const firstUsage = { input_tokens: 8300, output_tokens: 19, cache_read_input_tokens: 700 }
    const script = scriptedProvider((_request, index) => ({
      content: index === 0 ? [toolCall('pending')] : [{ type: 'text', text: 'Continued from the retained summary.' }],
      ...(usage === 'reported' ? { usage: index === 0 ? firstUsage : answerUsage } : {}),
    }), () => ({ content: [{ type: 'text', text: summary }], ...(usage === 'reported' ? { usage: summaryUsage } : {}) }))
    const config = sdk.resolveQueryConfig(options(profile))
    const checkpoint = join(profile, 'compact-checkpoint.json')
    const entered = createModelGate()
    const release = createModelGate()
    const events: SDKMessage[] = []
    let installed = false
    let persisted = false
    const run = (async () => {
      for await (const event of sdk.queryLoop(config, script.provider, [fixtureTool('New evidence: ' + 'r'.repeat(4800), executed)], compactHistory(), {
        async onCompact(messages, text) {
          entered.release()
          await release.promise
          await writeFile(checkpoint, JSON.stringify({ messages, summary: text }))
          persisted = true
        },
        onHistoryCompacted() { expect(persisted).toBe(true); installed = true },
      })) events.push(event)
    })()
    try {
      await Promise.race([entered.promise, run.then(() => { throw new Error('Compaction persistence was never reached') })])
      expect(script.exchanges.map(exchange => exchange.kind)).toEqual(['answer', 'summary'])
      expect(installed).toBe(false)
      expect(compactEvents(events)).toEqual([])
    } finally {
      release.release()
      await run
    }
    expect(installed).toBe(true)
    expect(executed).toEqual(['pending'])
    expect(script.exchanges.map(exchange => exchange.kind)).toEqual(['answer', 'summary', 'answer'])
    const [first, handover, next] = script.exchanges.map(exchange => exchange.request)
    expect(handover.systemPrompt).toEqual(first.systemPrompt)
    expect(handover.tools).toEqual(first.tools)
    expect(handover.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(handover.messages.slice(-3, -1)).toMatchObject([
      { role: 'assistant', content: [toolCall('pending')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-pending', content: 'New evidence: ' + 'r'.repeat(4800) }] },
    ])
    expect(handover.messages.at(-1)?.role).toBe('user')
    expect(handover.messages.at(-1)?.content).toEqual(expect.any(String))
    const saved = JSON.parse(await readFile(checkpoint, 'utf8')) as { messages: Message[]; summary: string }
    expect(saved.summary).toContain(summary)
    expect(next.messages.slice(-saved.messages.length)).toEqual(saved.messages)
    const budget = new sdk.TokenBudget(config.contextWindow, config.maxTokens)
    expect(budget.estimateRequest(first)).toBeLessThan(0.9 * (config.contextWindow - config.maxTokens))
    expect(budget.estimateRequest(next)).toBeLessThan(budget.estimateRequest(handover))
    expect(budget.estimateRequest(next)).toBeLessThan(config.contextWindow - config.maxTokens)
    const boundaries = compactEvents(events)
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ compact_metadata: { trigger: 'auto', pre_tokens: expect.any(Number) } })
    if (boundaries[0].type === 'system' && boundaries[0].subtype === 'compact_boundary') {
      expect(boundaries[0].compact_metadata.pre_tokens).toBeGreaterThanOrEqual(9000)
    }
    const result = resultOf(events)
    expect(result.is_error).toBe(false)
    const reported = usage === 'reported' ? [firstUsage, summaryUsage, answerUsage] : []
    for (const field of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
      const expected = reported.reduce((total, item: UsageInfo) => total + (item[field] ?? 0), 0)
      expect(result.usage[field] ?? 0).toBe(expected)
      expect(result.modelUsage[model][field]).toBe(expected)
    }
    expect(Number.isFinite(result.total_cost_usd)).toBe(true)
    expect(result.total_cost_usd).toBeCloseTo(reported.reduce((total, item) => total + cost(item), 0), 12)
    await info.attach('compaction-accounting', { body: JSON.stringify({ usage, requests: script.exchanges.map(exchange => ({ kind: exchange.kind, messages: exchange.request.messages.length })), boundaries, result }), contentType: 'application/json' })
  })
}

for (const failure of ['checkpoint-write', 'summary-tool-call'] as const) {
  test(`a ${failure} failure never installs reduced history or executes a summary tool`, {
    annotation: binding('chat.execution.compact-not-installed', { failure }),
  }, async ({ sdk, profile }) => {
    const executed: string[] = []
    const initial = compactHistory()
    const history = structuredClone(initial)
    let compactCalls = 0
    let installed = false
    const script = scriptedProvider(() => ({ content: [toolCall('pending')], usage: { input_tokens: 9000, output_tokens: 19 } }),
      () => ({ content: failure === 'summary-tool-call' ? [toolCall('forbidden-summary')] : [{ type: 'text', text: summary }], usage: summaryUsage }))
    const events = await collect(sdk.queryLoop(sdk.resolveQueryConfig(options(profile)), script.provider,
      [fixtureTool('New evidence: ' + 'r'.repeat(4800), executed)], history, {
        async onCompact() { compactCalls++; throw new Error('Isolated checkpoint write refused') },
        onHistoryCompacted() { installed = true },
      }))
    expect(resultOf(events).is_error).toBe(true)
    expect(compactEvents(events)).toEqual([])
    expect(installed).toBe(false)
    expect(compactCalls).toBe(failure === 'checkpoint-write' ? 1 : 0)
    expect(history.slice(0, initial.length)).toEqual(initial)
    expect(executed).toEqual(['pending'])
    expect(script.exchanges.map(exchange => exchange.kind)).toEqual(failure === 'summary-tool-call'
      ? ['answer', 'summary', 'summary'] : ['answer', 'summary'])
  })
}

for (const recovery of ['transient-summary', 'invalid-summary', 'provider-overflow', 'soft-failure'] as const) {
  test(`automatically recover ${recovery} without another user message`, {
    annotation: binding('chat.execution.compact-auto-recovery', { recovery }),
  }, async ({ sdk, profile }) => {
    let summaryAttempts = 0
    const script = scriptedProvider(() => ({ content: [{ type: 'text', text: 'Original task completed.' }], usage: answerUsage }), async () => {
      summaryAttempts++
      if (recovery === 'transient-summary' && summaryAttempts === 1) throw sdk.ProviderError.overloaded()
      if (recovery === 'soft-failure' || (recovery === 'invalid-summary' && summaryAttempts === 1)) {
        return { content: [], usage: summaryUsage }
      }
      return { content: [{ type: 'text', text: summary }], usage: summaryUsage }
    })
    const initial = compactHistory()
    const base = options(profile)
    const full = { messages: initial, systemPrompt, tools: [] }
    const estimate = new sdk.TokenBudget(base.contextWindow!, base.maxOutputTokens).estimateRequest(full)
    const capacity = recovery === 'soft-failure' ? Math.ceil(estimate / 0.95) : 7500
    let workAttempts = 0
    const stream = script.provider.createMessageStream.bind(script.provider)
    script.provider.createMessageStream = async function* (request) {
      if (recovery === 'provider-overflow' && workAttempts++ === 0) throw sdk.ProviderError.contextWindowExceeded()
      yield* stream(request)
    }
    let installed = 0
    const events = await collect(sdk.queryLoop(sdk.resolveQueryConfig({ ...base, contextWindow: capacity + 2000 }),
      script.provider, [], initial, { onCompact() { installed++ } }))
    const result = resultOf(events)
    expect(result.is_error).toBe(false)
    expect(result.subtype === 'success' && result.result).toContain('Original task completed.')
    const summaries = script.exchanges.filter(exchange => exchange.kind === 'summary')
    const answers = script.exchanges.filter(exchange => exchange.kind === 'answer')
    expect(answers).toHaveLength(1)
    expect(summaries).toHaveLength(2)
    expect(installed).toBe(recovery === 'soft-failure' ? 0 : recovery === 'provider-overflow' ? 2 : 1)
    for (const exchange of script.exchanges) {
      expect(exchange.request.systemPrompt).toEqual(systemPrompt)
      expect(exchange.request.tools).toEqual([])
    }
    if (recovery === 'transient-summary') {
      expect(summaries[1].request.messages).toEqual(summaries[0].request.messages)
      expect(events.some(event => event.type === 'system' && event.subtype === 'api_retry')).toBe(true)
    }
    if (recovery === 'invalid-summary') {
      expect(summaries[1].request.messages.slice(0, -1)).toEqual(summaries[0].request.messages.slice(0, -1))
      expect(summaries[1].request.messages.at(-1)).not.toEqual(summaries[0].request.messages.at(-1))
    }
    if (recovery === 'soft-failure') expect(answers[0].request.messages.slice(-initial.length)).toEqual(initial)
    const completedSummaries = recovery === 'transient-summary' ? 1 : 2
    expect(result.usage.input_tokens).toBe(answerUsage.input_tokens + completedSummaries * summaryUsage.input_tokens)
    expect(result.usage.output_tokens).toBe(answerUsage.output_tokens + completedSummaries * summaryUsage.output_tokens)
  })
}

for (const recovery of ['thinking-reservation', 'merge-reservation', 'merge-input'] as const) {
  test(`continue with ${recovery} context recovery`, {
    annotation: binding('chat.execution.compact-budget-recovery', { recovery }),
  }, async ({ sdk, profile }) => {
    const initial: Message[] = [{ role: 'user', content: 'Report only.' },
      ...Array.from({ length: 8 }, (_, index): Message => ({ role: index % 2 ? 'user' : 'assistant',
        content: `record-${index}: ${'evidence '.repeat(1200)}` })),
      { role: 'user', content: 'Final instruction: no writes.' },
    ]
    let successful = 0
    let rejectedMerge = 0
    const observed = new Set<number>()
    const script = scriptedProvider(() => ({ content: [{ type: 'text', text: 'Original task completed.' }], usage: answerUsage }), request => {
      const input = sdk.estimateMessageTokens(request.messages)
      const merged = request.messages.some(message => String(message.content).startsWith('Earlier record handover:'))
      const overflow = recovery === 'merge-input' ? input > 10500 : input + request.maxTokens > 16000
      if (recovery !== 'thinking-reservation' && overflow) {
        if (merged) rejectedMerge++
        throw sdk.ProviderError.contextWindowExceeded()
      }
      successful++
      for (const match of JSON.stringify(request.messages).matchAll(/record-(\d+)/g)) observed.add(Number(match[1]))
      const shortening = request.messages.some(message => String(message.content).startsWith('Record handover:'))
      const short = recovery === 'thinking-reservation' || shortening ||
        (recovery === 'merge-reservation' && request.maxTokens <= 4000) || (recovery === 'merge-input' && merged)
      return { content: [{ type: 'text', text: short ? 'Report-only work remains pending.' : 'state '.repeat(3000) }], usage: summaryUsage }
    })
    const config = sdk.resolveQueryConfig({ ...options(profile), contextWindow: 40000,
      maxOutputTokens: recovery === 'thinking-reservation' ? 8192 : 8000,
      thinking: recovery === 'thinking-reservation' ? { type: 'enabled', budgetTokens: 10000 } : { type: 'disabled' },
    })
    const events = await collect(sdk.queryLoop(config, script.provider, [], initial))
    const result = resultOf(events)
    expect(result.is_error).toBe(false)
    expect(compactEvents(events)).toHaveLength(1)
    const summaries = script.exchanges.filter(exchange => exchange.kind === 'summary')
    const answers = script.exchanges.filter(exchange => exchange.kind === 'answer')
    expect(answers).toHaveLength(1)
    expect(summaries.length).toBeLessThanOrEqual(16)
    expect(JSON.stringify(answers[0].request.messages)).toContain('Final instruction: no writes.')
    for (let index = 0; index < 8; index++) {
      expect(observed.has(index) || JSON.stringify(answers[0].request.messages).includes(`record-${index}`)).toBe(true)
    }
    if (recovery === 'thinking-reservation') {
      expect(summaries).toHaveLength(1)
      expect(summaries[0].request.maxTokens).toBeGreaterThan(8192)
      expect(answers[0].request.maxTokens).toBe(8192)
      expect(summaries[0].request.thinking).toEqual(answers[0].request.thinking)
    } else expect(rejectedMerge).toBeGreaterThan(0)
    expect(result.usage.input_tokens).toBe(answerUsage.input_tokens + successful * summaryUsage.input_tokens)
    expect(result.usage.output_tokens).toBe(answerUsage.output_tokens + successful * summaryUsage.output_tokens)
  })
}

for (const budget of ['large-ceiling', 'small-work-ceiling', 'explicit-output-range', 'unrelated-error', 'partial-content'] as const) {
  test(`output allowance preserves safe continuation for ${budget}`, {
    annotation: binding('chat.execution.output-allowance', { budget }),
  }, async ({ sdk, profile }, info) => {
    const ceiling = budget === 'small-work-ceiling' ? 300 : budget === 'large-ceiling' ? 320000 : 640000
    const contextWindow = budget === 'large-ceiling' ? 150000 : budget === 'small-work-ceiling' ? 40000 : 1000000
    const thinking = budget === 'large-ceiling' ? { type: 'enabled' as const, budgetTokens: 32000 } : { type: 'disabled' as const }
    const config = sdk.resolveQueryConfig({ ...options(profile), contextWindow, maxOutputTokens: ceiling, thinking })
    const attempts: ProviderRequest[] = []
    let checkpoints = 0
    const executed: string[] = []
    const script = scriptedProvider(() => ({ content: [{ type: 'text', text: 'Original task completed.' }], usage: answerUsage }), request => {
      expect(request.maxTokens).toBeGreaterThanOrEqual(1024)
      expect(request.maxTokens).toBeLessThanOrEqual(budget === 'large-ceiling' ? 52000 : 10000)
      expect(request.thinking).toEqual(thinking)
      if (budget === 'large-ceiling') {
        const textBudget = Number(String(request.messages.at(-1)?.content).match(/must fit within (\d+) output tokens/)?.[1])
        expect(textBudget).toBeGreaterThan(0)
        expect(textBudget).toBeLessThanOrEqual(20000)
        expect(textBudget + 32000).toBeLessThanOrEqual(request.maxTokens)
      }
      return { content: [{ type: 'text', text: summary }], usage: summaryUsage }
    })
    const stream = script.provider.createMessageStream.bind(script.provider)
    script.provider.createMessageStream = async function* (request) {
      attempts.push(snapshot(request))
      if (budget === 'unrelated-error') throw new sdk.ProviderError('Invalid parameter: max_tokens', { statusCode: 400 })
      if (budget === 'partial-content') {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Partial response' } }
        throw new sdk.ProviderError('max_tokens must be between 1 and 393216', { statusCode: 400 })
      }
      if (budget === 'explicit-output-range' && request.maxTokens > 393216) {
        throw new sdk.ProviderError('max_tokens must be between 1 and 393216', { statusCode: 400 })
      }
      const estimatedInput = new sdk.TokenBudget(contextWindow).estimateRequest(request)
      expect(estimatedInput + request.maxTokens).toBeLessThanOrEqual(contextWindow)
      yield* stream(request)
    }
    const history: Message[] = [...Array.from({ length: 24 }, (_, index): Message => ({
      role: index % 2 ? 'assistant' : 'user', content: `Record ${index}: ${'verified evidence '.repeat(budget === 'large-ceiling' ? 900 : 300)}`,
    })), { role: 'user', content: 'Complete the original task. Report only; do not edit files.' }]
    if (budget === 'large-ceiling') {
      const ordinary: Message[] = [{ role: 'user', content: 'Ordinary request. ' + 'evidence '.repeat(12000) }]
      const first = await collect(sdk.queryLoop(config, script.provider, [], ordinary))
      expect(resultOf(first).is_error).toBe(false)
      expect(compactEvents(first)).toHaveLength(0)
      expect(script.exchanges.map(exchange => exchange.kind)).toEqual(['answer'])
      expect(attempts[0].messages.slice(-ordinary.length)).toEqual(ordinary)
      script.exchanges.length = 0
      attempts.length = 0
    }
    const source = ['large-ceiling', 'small-work-ceiling'].includes(budget) ? history : [{ role: 'user' as const, content: 'Complete the original task. Report only; do not edit files.' }]
    const events = await collect(sdk.queryLoop(config, script.provider, [fixtureTool('No tool should run.', executed)], source, {
      onCompact() { checkpoints++ },
    }))
    const result = resultOf(events)
    const negative = budget === 'unrelated-error' || budget === 'partial-content'
    expect(result.is_error).toBe(negative)
    expect(config.maxTokens).toBe(ceiling)
    expect(executed).toEqual([])
    const summaries = script.exchanges.filter(exchange => exchange.kind === 'summary')
    if (budget === 'large-ceiling' || budget === 'small-work-ceiling') {
      expect(summaries).toHaveLength(1)
      expect(checkpoints).toBe(1)
      expect(compactEvents(events)).toHaveLength(1)
      expect(attempts).toHaveLength(1)
      expect(JSON.stringify(attempts[0].messages)).toContain('Report only; do not edit files.')
      expect(summaries[0].request.thinking).toEqual(attempts[0].thinking)
      expect(summaries[0].request.systemPrompt).toEqual(attempts[0].systemPrompt)
      expect(summaries[0].request.tools).toEqual(attempts[0].tools)
      if (budget === 'small-work-ceiling') expect(attempts[0].maxTokens).toBe(300)
    } else {
      expect(summaries).toHaveLength(0)
      expect(checkpoints).toBe(0)
      expect(compactEvents(events)).toHaveLength(0)
      expect(attempts).toHaveLength(budget === 'explicit-output-range' ? 2 : 1)
      if (budget === 'explicit-output-range') {
        expect(attempts.map(request => request.maxTokens)).toEqual([640000, 393216])
        expect(attempts[1].messages).toEqual(attempts[0].messages)
        expect(result.usage.output_tokens).toBe(answerUsage.output_tokens)
      }
    }
    await info.attach('output-allowance', { body: JSON.stringify({ budget, ceiling, contextWindow,
      allowances: attempts.map(request => request.maxTokens), summaries: summaries.map(exchange => exchange.request.maxTokens),
      checkpoints, executed, result }), contentType: 'application/json' })
  })
}

async function send(session: SDKSession, text: string) {
  await session.send(text)
  return collect(session.stream())
}

test('a compacted session resumes from its checkpoint without deleting the original transcript', {
  annotation: binding('chat.execution.compact-resume'),
}, async ({ sdk, profile }, info) => {
  const script = scriptedProvider(() => ({ content: [{ type: 'text', text: 'Completed original work: ' + 'a'.repeat(5000) }], usage: undefined }))
  const sessionOptions = { ...options(profile), contextWindow: 24000, provider: script.provider }
  const session = await sdk.createSession(sessionOptions)
  let transcript = ''
  let before = ''
  let compacted = false
  try {
    expect(resultOf(await send(session, 'Original request: ' + 'u'.repeat(5000))).is_error).toBe(false)
    await session.flush()
    const files = await readdir(profile, { recursive: true })
    transcript = join(profile, files.find(file => file.endsWith(`${session.sessionId}.jsonl`))!)
    before = await readFile(transcript, 'utf8')
    for (let index = 0; index < 10 && !compacted; index++) {
      const events = await send(session, `Follow-up ${index}: ${'u'.repeat(5000)}`)
      expect(resultOf(events).is_error).toBe(false)
      compacted = compactEvents(events).length > 0
    }
    expect(compacted).toBe(true)
  } finally {
    session.close()
    await session.flush()
  }
  const after = await readFile(transcript, 'utf8')
  expect(after.startsWith(before)).toBe(true)
  expect(after).toContain('Original request: ' + 'u'.repeat(5000))
  expect(after).toContain('Completed original work: ' + 'a'.repeat(5000))
  expect(after).toContain(summary)
  const resumedScript = scriptedProvider(() => ({ content: [{ type: 'text', text: 'Resumed the saved work.' }], usage: answerUsage }))
  const resumed = await sdk.createSession({ ...sessionOptions, provider: resumedScript.provider, resume: session.sessionId, strictResume: true })
  try {
    expect(resultOf(await send(resumed, 'Continue the saved work.'))).toMatchObject({ is_error: false, result: 'Resumed the saved work.' })
    expect(resumedScript.exchanges.map(exchange => exchange.kind)).toEqual(['answer'])
    expect(JSON.stringify(resumedScript.exchanges[0].request.messages)).toContain(summary)
    expect(JSON.stringify(resumedScript.exchanges[0].request.messages)).toContain('Continue the saved work.')
  } finally {
    resumed.close()
    await resumed.flush()
  }
  await info.attach('retained-transcript', { body: JSON.stringify({ sessionId: session.sessionId, originalBytes: Buffer.byteLength(before), compactedBytes: Buffer.byteLength(after), originalPrefixRetained: after.startsWith(before), resumedRequests: resumedScript.exchanges.length }), contentType: 'application/json' })
})
