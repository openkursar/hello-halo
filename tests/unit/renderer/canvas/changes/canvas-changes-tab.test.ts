/**
 * The changes tab: one per space for Git, one per reply for a reply's edits,
 * reopened rather than duplicated, and registered with a viewer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../../../src/renderer/api', () => ({
  api: {
    isRemoteMode: () => false,
    onBrowserStateChange: () => () => {},
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: () => () => {},
    getMemoryPressure: async () => 'normal',
  },
}))
vi.mock('../../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle, CONTENT_TYPES } = await import('../../../../../src/renderer/services/canvas-lifecycle')

beforeEach(async () => {
  await canvasLifecycle.closeAll()
})

describe('changes canvas tab', () => {
  it('is a content type', () => {
    expect(CONTENT_TYPES).toContain('changes')
  })

  it('keeps one Git tab per space, whatever repository is asked for', async () => {
    const first = await canvasLifecycle.openChanges({ kind: 'git', spaceId: 's1' })
    const again = await canvasLifecycle.openChanges({ kind: 'git', spaceId: 's1', repoRoot: '/w/nested' })
    const other = await canvasLifecycle.openChanges({ kind: 'git', spaceId: 's2' })

    expect(again).toBe(first)
    expect(other).not.toBe(first)
    const tab = canvasLifecycle.getTab(first)!
    expect(tab.type).toBe('changes')
    expect(tab.title).toBe('Changes')
    expect(tab.changes).toEqual({ kind: 'git', spaceId: 's1' })
  })

  it('keeps one tab per reply, titled after it', async () => {
    const source = { kind: 'message' as const, spaceId: 's', conversationId: 'c', messageId: 'm1', title: 'Reply 15:42', replyAt: 1 }
    const first = await canvasLifecycle.openChanges(source)
    const again = await canvasLifecycle.openChanges({ ...source })
    const other = await canvasLifecycle.openChanges({ ...source, messageId: 'm2' })
    const git = await canvasLifecycle.openChanges({ kind: 'git', spaceId: 's' })

    expect(again).toBe(first)
    expect(new Set([first, other, git]).size).toBe(3)
    expect(canvasLifecycle.getTab(first)!.title).toBe('Changes · Reply 15:42')
    expect(canvasLifecycle.getActiveTabId()).toBe(git)
    expect(canvasLifecycle.getIsOpen()).toBe(true)
  })

  it('is not loading: the viewer loads what it shows itself', async () => {
    const id = await canvasLifecycle.openChanges({ kind: 'git', spaceId: 's' })
    expect(canvasLifecycle.getTab(id)).toMatchObject({ isLoading: false, isDirty: false })
  })

  it('hands a place to show to the tab, new or reopened, each request distinct', async () => {
    const id = await canvasLifecycle.openChanges({ kind: 'git', spaceId: 's' }, { reveal: { page: 'overview' } })
    const first = canvasLifecycle.getTab(id)!.reveal!
    expect(first).toMatchObject({ page: 'overview' })

    const target = { path: '/w/repo/src/a.ts', side: 'before' as const, range: { startLine: 3, endLine: 4 }, quote: 'x' }
    expect(await canvasLifecycle.openChanges({ kind: 'git', spaceId: 's' }, { reveal: target })).toBe(id)
    const second = canvasLifecycle.getTab(id)!.reveal!
    expect(second).toMatchObject(target)
    expect(second.seq).not.toBe(first.seq)
  })
})
