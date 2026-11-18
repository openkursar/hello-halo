import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ credentials: vi.fn(), group: vi.fn(), source: vi.fn() }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({ getApiCredentialsForStrictSelection: mocks.credentials }))
vi.mock('../../../../src/main/services/ai-sources', () => ({ getGroup: mocks.group, getAISourceManager: () => ({ getSourceConfig: mocks.source }) }))
import { prepareSubagentModelMetadata } from '../../../../src/main/services/agent/subagent-model-metadata'

describe('subagent model metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.credentials.mockResolvedValue({ sourceId: 'account', model: 'unknown-model', provider: 'openai', apiType: 'responses', supportsVision: true,
      capabilities: { contextWindow: 32000, maxOutputTokens: 8192 } })
  })
  it('does not invent supported levels for an unknown model', async () => {
    const result = await prepareSubagentModelMetadata({ modelSourceId: 'account', modelId: 'unknown-model' }, 'halo')
    expect(result.metadata.reasoning.supported).toBeUndefined()
    expect(result.metadata.contextWindow).toBe(32000)
    expect(result.metadata.modalities).toEqual(['text', 'image'])
    expect(result.metadata.restoreRef).toBe(JSON.stringify({ sourceId: 'account', modelId: 'unknown-model' }))
  })
  it('declares off only for models with a verified off control', async () => {
    mocks.credentials.mockResolvedValue({ model: 'claude-opus-4-6', provider: 'openai',
      capabilities: { contextWindow: 32000, maxOutputTokens: 8192 } })
    const result = await prepareSubagentModelMetadata({ modelSourceId: 'account', modelId: 'claude-opus-4-6' }, 'halo')
    expect(result.metadata.reasoning.effortMapping?.off).toEqual({ version: 1, mode: 'off' })
    expect(result.metadata.reasoning.supported).toContain('off')
  })
  it('declares a bounded budget mode for a known budget model', async () => {
    mocks.credentials.mockResolvedValue({ model: 'claude-sonnet-4-5', provider: 'anthropic',
      capabilities: { contextWindow: 32000, maxOutputTokens: 8192 } })
    const result = await prepareSubagentModelMetadata({ modelSourceId: 'account', modelId: 'claude-sonnet-4-5' }, 'halo')
    expect(result.metadata.reasoning.modes).toContain('budget')
    expect(result.metadata.reasoning.maxBudgetTokens).toBe(8191)
  })
  it('does not advertise a budget mode for adaptive models', async () => {
    mocks.credentials.mockResolvedValue({ model: 'claude-opus-4-6', provider: 'anthropic',
      capabilities: { contextWindow: 32000, maxOutputTokens: 8192, adaptiveThinking: true } })
    const result = await prepareSubagentModelMetadata({ modelSourceId: 'account', modelId: 'claude-opus-4-6' }, 'halo')
    expect(result.metadata.reasoning.modes).toContain('adaptive')
    expect(result.metadata.reasoning.modes).not.toContain('budget')
    expect(result.metadata.reasoning.maxBudgetTokens).toBeUndefined()
  })
  it.each([
    ['gpt-6-1-sol', 'max', { version: 1, mode: 'effort', effort: 'max' }],
    ['gpt-6-luna', 'off', { version: 1, mode: 'off' }],
  ])('exposes the actual Codex upstream %s %s capability', async (model, effort, expected) => {
    mocks.credentials.mockResolvedValue({ model, provider: 'openai', apiType: 'chat_completions',
      capabilities: { contextWindow: 32000, maxOutputTokens: 8192 } })
    const result = await prepareSubagentModelMetadata({ modelSourceId: 'account', modelId: model }, 'codex')
    expect(result.metadata.reasoning.supported).toContain(effort)
    expect(result.metadata.reasoning.effortMapping?.[effort]).toEqual(expected)
  })
  it('describes dsh upstream effort instead of its fixed native provider controls', async () => {
    mocks.credentials.mockResolvedValue({ model: 'o3', provider: 'openai', apiType: 'chat_completions',
      capabilities: { contextWindow: 32000, maxOutputTokens: 8192 } })
    const result = await prepareSubagentModelMetadata({ modelSourceId: 'account', modelId: 'o3' }, 'dsh')
    expect(result.metadata.reasoning.default).toEqual({ version: 1, mode: 'effort', effort: 'low' })
    expect(result.metadata.reasoning.effortMapping?.low).toEqual({ version: 1, mode: 'effort', effort: 'low' })
    expect(result.metadata.reasoning.modes).not.toContain('adaptive')
  })
  it('rejects a protocol Codex cannot use', async () => {
    mocks.credentials.mockResolvedValue({ provider: 'anthropic', model: 'claude', capabilities: { contextWindow: 32000, maxOutputTokens: 8192 } })
    await expect(prepareSubagentModelMetadata({ modelSourceId: 'account', modelId: 'claude' }, 'codex')).rejects.toThrow('OpenAI-compatible')
  })
  it('preserves route defaults rather than inventing a uniform group budget', async () => {
    mocks.credentials.mockResolvedValue({ isGroup: true, model: 'halo-auto', provider: 'openai',
      capabilities: { contextWindow: 32000, maxOutputTokens: 8192 } })
    mocks.group.mockReturnValue({ members: [{ sourceId: 'a', modelId: 'claude-sonnet-4-5' }, { sourceId: 'b', modelId: 'claude-opus-4-6' }] })
    mocks.source.mockReturnValue({ authType: 'api-key', apiKey: 'synthetic', provider: 'openai', apiType: 'chat_completions' })
    const result = await prepareSubagentModelMetadata({ modelSourceId: 'group', modelId: 'halo-auto' }, 'halo')
    expect(result.metadata.reasoning.default).toEqual({ version: 1, mode: 'provider-default' })
    expect(result.metadata.targetKind).toBe('pool')
    expect(result.metadata.reasoning.modes).not.toContain('budget')
    expect(result.metadata.reasoning.maxBudgetTokens).toBeUndefined()
  })
  it('propagates strict restore failure instead of resolving another account', async () => {
    mocks.credentials.mockRejectedValue(new Error('removed account'))
    await expect(prepareSubagentModelMetadata({ modelSourceId: 'removed', modelId: 'model' }, 'halo')).rejects.toThrow('removed account')
    expect(mocks.credentials).toHaveBeenCalledOnce()
  })
})
