import { describe, expect, it, vi } from 'vitest'
import { captureDelegatedModelContext, getSessionDelegatedModelContext, setSessionDelegatedModelContext } from '../../../../src/main/services/agent/delegated-model'

describe('delegated execution snapshots', () => {
  it('keeps actual session identities isolated and updates only the named execution', () => {
    const first = {}, second = {}
    const context = captureDelegatedModelContext({ modelSourceId: 'account', modelId: 'model' }, 'halo',
      { thinking: { type: 'disabled' } })
    setSessionDelegatedModelContext(first, context)
    expect(getSessionDelegatedModelContext(first)).toBe(context)
    expect(getSessionDelegatedModelContext(second)).toBeUndefined()
  })

  it('leaves an unrepresentable unbound budget to the existing engine route', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const selection = { modelSourceId: 'account', modelId: 'claude-sonnet-4-5' }
    const options = { model: selection.modelId, apiCredentials: { provider: 'anthropic' }, reasoningEffort: 'high' }
    try {
      const context = captureDelegatedModelContext(selection, 'dsh', options)
      expect(context).toEqual({ selection, engineId: 'dsh', reasoningLevel: 'high' })
      expect(warn).toHaveBeenCalledOnce()
      expect(() => captureDelegatedModelContext(selection, 'dsh', options, {
        version: 1, selection: { kind: 'inherit' }, bindingId: 'binding', restoreRef: 'restore',
        model: selection.modelId, targetKind: 'single', reasoning: { version: 1, mode: 'off' },
      })).toThrow('token budget')
    } finally { warn.mockRestore() }
  })

  it('a new child binding uses current direct-parent reasoning rather than an older inherited setting', () => {
    const previous = { version: 1 as const, selection: { kind: 'inherit' as const }, bindingId: 'binding',
      restoreRef: 'restore', model: 'model', targetKind: 'single' as const,
      reasoning: { version: 1 as const, mode: 'off' as const } }
    const current = { version: 1 as const, mode: 'budget' as const, budgetTokens: 8192, effort: 'high' }
    const context = captureDelegatedModelContext({ modelSourceId: 'account', modelId: 'model' }, 'halo',
      { thinking: { type: 'enabled', budgetTokens: 8192 }, reasoningEffort: 'high' }, previous)
    expect(context.modelBinding?.reasoning).toEqual(current)
    expect(context.reasoning).toEqual(current)
    expect(previous.reasoning.mode).toBe('off')
  })
})
