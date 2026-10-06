/**
 * The goal editor tab: one per conversation, a close that would lose unsaved
 * edits asks first through whichever guard owns that tab type (for a single
 * close or a user's close-all, never for space-switch teardown), and Refresh
 * reaches whoever owns that tab type.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../src/renderer/api', () => ({
  api: { onBrowserPageGone: () => () => {}, onBrowserStateChange: () => () => {}, onArtifactChangedBatch: () => () => {}, onMemoryPressure: () => () => {}, getMemoryPressure: async () => 'normal' },
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../src/renderer/services/canvas-lifecycle')

beforeEach(async () => {
  await canvasLifecycle.closeAll()
})

describe('goal canvas tab', () => {
  it('reuses the open tab of the same conversation', async () => {
    const first = await canvasLifecycle.openGoal('s', 'c1')
    const again = await canvasLifecycle.openGoal('s', 'c1')
    const other = await canvasLifecycle.openGoal('s', 'c2')

    expect(again).toBe(first)
    expect(other).not.toBe(first)
    expect(canvasLifecycle.getTabs().filter((t) => t.type === 'goal')).toHaveLength(2)
    expect(canvasLifecycle.getActiveTabId()).toBe(other)
    expect(canvasLifecycle.getTabs().find((t) => t.id === first)?.goal).toEqual({ spaceId: 's', conversationId: 'c1' })
  })

  it('asks the registered guard before closing a dirty tab, and keeps it on "no"', async () => {
    const guard = vi.fn(async () => false)
    const unregister = canvasLifecycle.setDirtyCloseGuard('goal', guard)
    const tabId = await canvasLifecycle.openGoal('s', 'c1')
    canvasLifecycle.updateTabContent(tabId, '{}')

    await canvasLifecycle.closeTab(tabId)
    expect(guard).toHaveBeenCalledOnce()
    expect(canvasLifecycle.getTabs().some((t) => t.id === tabId)).toBe(true)

    guard.mockResolvedValueOnce(true)
    await canvasLifecycle.closeTab(tabId)
    expect(canvasLifecycle.getTabs().some((t) => t.id === tabId)).toBe(false)
    unregister()
  })

  it('closes a clean tab, or one with no guard, without asking', async () => {
    const guard = vi.fn(async () => false)
    const unregister = canvasLifecycle.setDirtyCloseGuard('goal', guard)
    const clean = await canvasLifecycle.openGoal('s', 'c1')
    await canvasLifecycle.closeTab(clean)
    expect(guard).not.toHaveBeenCalled()
    unregister()

    const dirty = await canvasLifecycle.openGoal('s', 'c2')
    canvasLifecycle.updateTabContent(dirty, '{}')
    await canvasLifecycle.closeTab(dirty)
    expect(canvasLifecycle.getTabs()).toHaveLength(0)
  })

  it('asks before a user close-all drops a dirty tab, and one "keep" cancels it', async () => {
    const guard = vi.fn(async () => false)
    const unregister = canvasLifecycle.setDirtyCloseGuard('goal', guard)
    await canvasLifecycle.openGoal('s', 'c1')
    const dirty = await canvasLifecycle.openGoal('s', 'c2')
    canvasLifecycle.updateTabContent(dirty, '{}')

    await canvasLifecycle.closeAll({ confirmDirty: true })
    expect(guard).toHaveBeenCalledOnce()
    expect(canvasLifecycle.getTabs()).toHaveLength(2)

    guard.mockResolvedValueOnce(true)
    await canvasLifecycle.closeAll({ confirmDirty: true })
    expect(canvasLifecycle.getTabs()).toHaveLength(0)
    unregister()
  })

  it('never asks on teardown close-all', async () => {
    const guard = vi.fn(async () => false)
    const unregister = canvasLifecycle.setDirtyCloseGuard('goal', guard)
    const dirty = await canvasLifecycle.openGoal('s', 'c1')
    canvasLifecycle.updateTabContent(dirty, '{}')

    await canvasLifecycle.closeAll()
    expect(guard).not.toHaveBeenCalled()
    expect(canvasLifecycle.getTabs()).toHaveLength(0)
    unregister()
  })

  it('refreshes a goal tab through the registered handler', async () => {
    const handler = vi.fn(async () => {})
    const unregister = canvasLifecycle.setRefreshHandler('goal', handler)
    const tabId = await canvasLifecycle.openGoal('s', 'c1')

    await canvasLifecycle.refreshTab(tabId)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: tabId }))
    unregister()
  })

  it('renames a tab', async () => {
    const tabId = await canvasLifecycle.openGoal('s', 'c1')
    canvasLifecycle.setTabTitle(tabId, 'Goal · Release')
    expect(canvasLifecycle.getTab(tabId)?.title).toBe('Goal · Release')
  })
})
