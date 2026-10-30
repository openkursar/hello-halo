import { describe, expect, it } from 'vitest'
import { assertEngineSourceCompatible, getEngineSourceCompatibility } from '../../../src/shared/engine-source'

describe('engine account compatibility', () => {
  it.each(['halo', 'codex', 'dsh'] as const)('refuses delegated CLI accounts on %s', engineId => {
    expect(getEngineSourceCompatibility(engineId, { authType: 'delegated' })).toMatchObject({ compatible: false, code: 'delegated-requires-cc' })
    expect(() => assertEngineSourceCompatible(engineId, { delegatedAuth: true })).toThrow('requires Claude Code')
  })
  it('keeps delegated accounts on Claude Code', () => {
    expect(getEngineSourceCompatibility('anthropic', { delegatedAuth: true, apiType: 'anthropic_passthrough' })).toEqual({ compatible: true })
  })
  it.each([
    { provider: 'anthropic' }, { provider: 'claude', authType: 'oauth' }, { provider: 'oauth', oauthProvider: 'claude' },
    { provider: 'custom', apiType: 'anthropic_passthrough' }, { provider: 'custom', apiType: 'kiro' }, { provider: 'custom', apiType: 'unknown' },
  ])('refuses unsupported Codex protocol %o', source => {
    expect(getEngineSourceCompatibility('codex', source)).toMatchObject({ compatible: false, code: 'codex-unsupported-protocol' })
  })
  it.each(['chat_completions', 'responses', undefined])('accepts an OpenAI-compatible %s source without inspecting model names', apiType => {
    expect(getEngineSourceCompatibility('codex', { provider: 'openai', apiType })).toEqual({ compatible: true })
  })
  it.each(['halo', 'anthropic', 'dsh'] as const)('does not restrict existing %s protocol handling', engineId => {
    expect(getEngineSourceCompatibility(engineId, { provider: 'anthropic', apiType: 'anthropic_passthrough' })).toEqual({ compatible: true })
  })
})
