/**
 * Clearing an active goal is undoable rather than confirmed, so the undo has
 * to be there the moment the goal disappears, bring back what was cleared,
 * expire on its own, and vanish again if main refuses the clear. A finished
 * goal is dismissed with no undo: main could only bring it back as active.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const api = vi.hoisted(() => ({ getGoal: vi.fn(), setGoal: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api }))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { useGoalStore } = await import('../../../src/renderer/stores/goal.store')
const { useGoalUiStore, GOAL_UNDO_MS } = await import('../../../src/renderer/stores/goal-ui.store')
const { useNotificationStore } = await import('../../../src/renderer/stores/notification.store')
const { clearGoal, undoClearGoal, saveGoal } = await import('../../../src/renderer/components/goal/goal-actions')

const active = {
  objective: 'Ship it',
  doneWhen: ['Tests pass'],
  status: 'active' as const,
  note: 'dropped on undo',
  updatedBy: 'agent' as const,
  updatedAt: 't',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  useGoalStore.setState({ byConversation: new Map([['c', active]]), unseenByModel: new Set() })
  useGoalUiStore.setState({ undo: new Map(), expanded: new Set(['c']), composerGoalMode: new Set() })
  useNotificationStore.setState({ toasts: [] })
})

afterEach(() => { vi.useRealTimers() })

describe('goal actions', () => {
  it('clears at once, offers undo, and undo restores objective and criteria', async () => {
    api.setGoal.mockResolvedValueOnce({ success: true, data: null })
    const clearing = clearGoal('s', 'c', active)

    expect(useGoalStore.getState().byConversation.get('c')).toBeNull()
    expect(useGoalUiStore.getState().undo.get('c')?.previous).toEqual({ objective: 'Ship it', doneWhen: ['Tests pass'] })
    expect(useGoalUiStore.getState().expanded.has('c')).toBe(false)
    expect(await clearing).toBe(true)

    api.setGoal.mockResolvedValueOnce({ success: true, data: { ...active, note: undefined, updatedBy: 'user' } })
    await undoClearGoal('s', 'c')
    expect(api.setGoal).toHaveBeenLastCalledWith('s', 'c', { objective: 'Ship it', doneWhen: ['Tests pass'] })
    expect(useGoalStore.getState().byConversation.get('c')?.objective).toBe('Ship it')
    expect(useGoalUiStore.getState().undo.has('c')).toBe(false)
  })

  it('stops offering undo after the window', async () => {
    api.setGoal.mockResolvedValueOnce({ success: true, data: null })
    await clearGoal('s', 'c', active)
    vi.advanceTimersByTime(GOAL_UNDO_MS - 1)
    expect(useGoalUiStore.getState().undo.has('c')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(useGoalUiStore.getState().undo.has('c')).toBe(false)
  })

  it('puts the goal back and tells the user when main refuses the clear', async () => {
    api.setGoal.mockResolvedValueOnce({ success: false, error: 'session is not available' })
    expect(await clearGoal('s', 'c', active)).toBe(false)

    expect(useGoalStore.getState().byConversation.get('c')).toEqual(active)
    expect(useGoalUiStore.getState().undo.has('c')).toBe(false)
    expect(useNotificationStore.getState().toasts.map((t) => t.variant)).toEqual(['error'])
  })

  it('dismisses a finished goal with no undo', async () => {
    const achieved = { ...active, status: 'complete' as const }
    useGoalStore.setState({ byConversation: new Map([['c', achieved]]), unseenByModel: new Set() })
    api.setGoal.mockResolvedValueOnce({ success: true, data: null })

    expect(await clearGoal('s', 'c', achieved)).toBe(true)
    expect(useGoalStore.getState().byConversation.get('c')).toBeNull()
    expect(useGoalUiStore.getState().undo.has('c')).toBe(false)
    expect(api.setGoal).toHaveBeenCalledOnce()
  })

  it('puts a finished goal back when main refuses the dismissal', async () => {
    const achieved = { ...active, status: 'complete' as const }
    useGoalStore.setState({ byConversation: new Map([['c', achieved]]), unseenByModel: new Set() })
    api.setGoal.mockResolvedValueOnce({ success: false, error: 'nope' })

    expect(await clearGoal('s', 'c', achieved)).toBe(false)
    expect(useGoalStore.getState().byConversation.get('c')).toEqual(achieved)
    expect(useNotificationStore.getState().toasts.map((t) => t.variant)).toEqual(['error'])
  })

  it('rolls a refused save back to the previous goal', async () => {
    api.setGoal.mockResolvedValueOnce({ success: false, error: 'nope' })
    expect(await saveGoal('s', 'c', { objective: 'Other' })).toBe(false)
    expect(useGoalStore.getState().byConversation.get('c')).toEqual(active)
  })
})
