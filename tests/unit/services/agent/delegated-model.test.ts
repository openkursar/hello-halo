import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({
  captureEffectiveReasoning: (options: { captured: unknown }) => options.captured,
}))
import { captureDelegatedModelContext, getSessionDelegatedModelContext, setSessionDelegatedModelContext } from '../../../../src/main/services/agent/delegated-model'

describe('delegated execution snapshots', () => {
  it('keeps actual session identities isolated and updates only the named execution', () => {
    const first = {}, second = {}
    const context = captureDelegatedModelContext({ modelSourceId: 'account', modelId: 'model' }, 'halo',
      { captured: { version: 1, mode: 'off' } })
    setSessionDelegatedModelContext(first, context)
    expect(getSessionDelegatedModelContext(first)).toBe(context)
    expect(getSessionDelegatedModelContext(second)).toBeUndefined()
  })

  it('a new child binding uses current direct-parent reasoning rather than an older inherited setting', () => {
    const previous = { version: 1 as const, selection: { kind: 'inherit' as const }, bindingId: 'binding',
      restoreRef: 'restore', model: 'model', targetKind: 'single' as const,
      reasoning: { version: 1 as const, mode: 'off' as const } }
    const current = { version: 1 as const, mode: 'budget' as const, budgetTokens: 8192, effort: 'high' }
    const context = captureDelegatedModelContext({ modelSourceId: 'account', modelId: 'model' }, 'halo',
      { captured: current }, previous)
    expect(context.modelBinding?.reasoning).toEqual(current)
    expect(context.reasoning).toEqual(current)
    expect(previous.reasoning.mode).toBe('off')
  })
})
