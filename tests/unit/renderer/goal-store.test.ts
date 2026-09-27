/**
 * The renderer goal mirror: main is authoritative, so a read that started
 * before a newer change must not overwrite it, and the "model has not seen
 * this yet" flag follows the engine's echo rather than the user's own save.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getGoal: vi.fn(),
  setGoal: vi.fn(),
  getEngineCapabilities: vi.fn(async () => ({ success: false })),
}))
vi.mock('../../../src/renderer/api', () => ({ api }))

const { useGoalStore } = await import('../../../src/renderer/stores/goal.store')
const { useGoalUiStore } = await import('../../../src/renderer/stores/goal-ui.store')

const goal = (objective: string, updatedBy: 'agent' | 'user' = 'user') => ({
  objective,
  doneWhen: [],
  status: 'active' as const,
  updatedBy,
  updatedAt: 't',
})

const state = () => useGoalStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useGoalStore.setState({ byConversation: new Map(), unseenByModel: new Set() })
})

describe('goal store', () => {
  it('keeps a newer event over a load that was already in flight', async () => {
    let resolveLoad!: (v: unknown) => void
    api.getGoal.mockReturnValueOnce(new Promise((r) => { resolveLoad = r }))

    const loading = state().load('s', 'c')
    state().applyUpdatedEvent({ spaceId: 's', conversationId: 'c', goal: goal('new', 'agent'), source: 'agent', seenByModel: true })
    resolveLoad({ success: true, data: goal('stale') })
    await loading

    expect(state().byConversation.get('c')?.objective).toBe('new')
  })

  it('marks a user save unseen until the engine echoes it', async () => {
    api.setGoal.mockResolvedValueOnce({ success: true, data: goal('mine') })

    expect(await state().set('s', 'c', { objective: 'mine' })).toEqual({ success: true })
    expect(state().unseenByModel.has('c')).toBe(true)

    state().applyUpdatedEvent({ spaceId: 's', conversationId: 'c', goal: goal('mine'), source: 'user', seenByModel: true })
    expect(state().unseenByModel.has('c')).toBe(false)
  })

  it('clears the unseen flag at turn end', () => {
    useGoalStore.setState({ byConversation: new Map([['c', null]]) })
    state().applyUpdatedEvent({ spaceId: 's', conversationId: 'c', goal: null, source: 'user', seenByModel: false })
    expect(state().unseenByModel.has('c')).toBe(true)
    state().markTurnEnded('c')
    expect(state().unseenByModel.has('c')).toBe(false)
  })

  it('reports a failed save without touching the mirror', async () => {
    useGoalStore.setState({ byConversation: new Map([['c', goal('kept')]]) })
    api.setGoal.mockResolvedValueOnce({ success: false, error: 'nope' })

    expect(await state().clear('s', 'c')).toEqual({ success: false, error: 'nope' })
    expect(state().byConversation.get('c')?.objective).toBe('kept')
  })

  it('shows an optimistic change at once and rolls it back to the previous value', () => {
    useGoalStore.setState({ byConversation: new Map([['c', goal('before')]]) })

    const rollback = state().applyOptimistic('c', null)
    expect(state().byConversation.get('c')).toBeNull()

    rollback()
    expect(state().byConversation.get('c')?.objective).toBe('before')
    expect(state().unseenByModel.has('c')).toBe(false)
  })

  it('marks an optimistic change unseen unless main applies it before the turn', () => {
    state().applyOptimistic('c', goal('edit'))
    expect(state().unseenByModel.has('c')).toBe(true)

    state().applyOptimistic('c', goal('sent'), { unseen: false })
    expect(state().unseenByModel.has('c')).toBe(false)
  })

  it('rolls an optimistic change back to "not loaded" when nothing was loaded', () => {
    const rollback = state().applyOptimistic('c', goal('guess'))
    rollback()
    expect(state().byConversation.has('c')).toBe(false)
  })

  it('never lets a rollback overwrite a newer change', () => {
    const rollback = state().applyOptimistic('c', goal('mine'))
    state().applyUpdatedEvent({ spaceId: 's', conversationId: 'c', goal: goal('agent', 'agent'), source: 'agent', seenByModel: true })

    rollback()
    expect(state().byConversation.get('c')?.objective).toBe('agent')
  })

  it('ignores events for a conversation it never read', () => {
    state().applyUpdatedEvent({ spaceId: 's', conversationId: 'app-chat:x', goal: goal('elsewhere', 'agent'), source: 'agent', seenByModel: true })
    expect(state().byConversation.has('app-chat:x')).toBe(false)
  })

  it('shows the first goal the agent sets in a conversation it has read', async () => {
    api.getGoal.mockResolvedValueOnce({ success: true, data: null })
    await state().load('s', 'c')

    state().applyUpdatedEvent({ spaceId: 's', conversationId: 'c', goal: goal('first', 'agent'), source: 'agent', seenByModel: true })
    expect(state().byConversation.get('c')?.objective).toBe('first')
  })

  it('forgets a deleted conversation everywhere', () => {
    useGoalStore.setState({ byConversation: new Map([['c', goal('x')], ['d', null]]), unseenByModel: new Set(['c']) })
    const ui = useGoalUiStore.getState()
    ui.setComposerGoalMode('c', true)
    ui.setExpanded('c', true)
    ui.offerUndo('c', { objective: 'x' })

    state().forget('c')
    useGoalUiStore.getState().forget('c')

    expect(state().byConversation.has('c')).toBe(false)
    expect(state().byConversation.has('d')).toBe(true)
    expect(state().unseenByModel.has('c')).toBe(false)
    const after = useGoalUiStore.getState()
    expect(after.composerGoalMode.has('c') || after.expanded.has('c') || after.undo.has('c')).toBe(false)
  })
})
