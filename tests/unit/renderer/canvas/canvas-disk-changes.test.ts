/**
 * Files rewritten on disk reach open canvas tabs without destroying work: a
 * clean tab re-reads in place, a tab with unsaved edits is never overwritten
 * and instead asks the user which side to keep.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const disk = new Map<string, string>()
const readArtifactContent = vi.fn(async (path: string) =>
  disk.has(path)
    ? { success: true, data: { content: disk.get(path)!, mimeType: 'text/plain' } }
    : { success: false, error: 'ENOENT' }
)

vi.mock('../../../../src/renderer/api', () => ({
  api: {
    onBrowserStateChange: () => () => {},
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: () => () => {},
    getMemoryPressure: async () => 'normal',
    readArtifactContent: (path: string) => readArtifactContent(path),
    isRemoteMode: () => false,
    hideBrowserView: vi.fn(async () => ({ success: true })),
  },
}))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const tabOf = (id: string) => canvasLifecycle.getTab(id)!
const changed = (path: string, type: 'change' | 'add' = 'change') =>
  canvasLifecycle.handleArtifactChanges({ spaceId: 's', changes: [{ type, path, relativePath: path }] })

async function open(path: string, content: string): Promise<string> {
  disk.set(path, content)
  const id = await canvasLifecycle.openFile(path)
  await flush()
  return id
}

beforeEach(async () => {
  await canvasLifecycle.closeAll()
  disk.clear()
  readArtifactContent.mockClear()
})

describe('a clean tab', () => {
  it('re-reads in place, without passing through a loading state', async () => {
    const id = await open('/w/a.ts', 'v1')
    const seen: boolean[] = []
    const off = canvasLifecycle.onTabChange(tab => { if (tab.id === id) seen.push(tab.isLoading) })

    disk.set('/w/a.ts', 'v2')
    changed('/w/a.ts')
    await flush()
    off()

    expect(tabOf(id).content).toBe('v2')
    expect(seen).not.toContain(true)
  })

  it('treats an atomic rewrite (add) like a change', async () => {
    const id = await open('/w/a.ts', 'v1')
    disk.set('/w/a.ts', 'v2')
    changed('/w/a.ts', 'add')
    await flush()
    expect(tabOf(id).content).toBe('v2')
  })

  it('ignores changes to files that are not open', async () => {
    await open('/w/a.ts', 'v1')
    readArtifactContent.mockClear()
    changed('/w/other.ts')
    await flush()
    expect(readArtifactContent).not.toHaveBeenCalled()
  })

  it('re-reads every open file on a resync', async () => {
    const a = await open('/w/a.ts', 'a1')
    const b = await open('/w/b.ts', 'b1')
    disk.set('/w/a.ts', 'a2')
    disk.set('/w/b.ts', 'b2')
    canvasLifecycle.handleArtifactChanges({ spaceId: 's', changes: [], resync: true })
    await flush()
    expect([tabOf(a).content, tabOf(b).content]).toEqual(['a2', 'b2'])
  })
})

describe('a tab with unsaved edits', () => {
  it('is never overwritten; a real divergence raises a conflict', async () => {
    const id = await open('/w/a.ts', 'v1')
    canvasLifecycle.updateTabContent(id, 'mine')

    disk.set('/w/a.ts', 'theirs')
    changed('/w/a.ts')
    await flush()

    expect(tabOf(id)).toMatchObject({ content: 'mine', isDirty: true, diskConflict: true })
  })

  it('does not treat its own save echoing back as a conflict', async () => {
    const id = await open('/w/a.ts', 'v1')
    canvasLifecycle.updateTabContent(id, 'v2')
    canvasLifecycle.markTabSaved(id, 'v2')
    disk.set('/w/a.ts', 'v2')
    // The user keeps typing before the watcher reports the save.
    canvasLifecycle.updateTabContent(id, 'v3')
    changed('/w/a.ts')
    await flush()
    expect(tabOf(id).diskConflict).toBeFalsy()
  })

  it('loads the disk version when the user picks it', async () => {
    const id = await open('/w/a.ts', 'v1')
    canvasLifecycle.updateTabContent(id, 'mine')
    disk.set('/w/a.ts', 'theirs')
    changed('/w/a.ts')
    await flush()

    canvasLifecycle.resolveDiskConflict(id, 'disk')
    expect(tabOf(id)).toMatchObject({ content: 'theirs', isDirty: false, diskConflict: false })
    expect(tabOf(id).savedContent).toBeUndefined()
  })

  it('keeps the edits when the user picks them, reverting to the new disk text later', async () => {
    const id = await open('/w/a.ts', 'v1')
    canvasLifecycle.updateTabContent(id, 'mine')
    disk.set('/w/a.ts', 'theirs')
    changed('/w/a.ts')
    await flush()

    canvasLifecycle.resolveDiskConflict(id, 'mine')
    expect(tabOf(id)).toMatchObject({ content: 'mine', isDirty: true, diskConflict: false })

    canvasLifecycle.revertTabContent(id)
    expect(tabOf(id)).toMatchObject({ content: 'theirs', isDirty: false })
  })

  it('flags a conflict when editing started while a refresh was in flight', async () => {
    const id = await open('/w/a.ts', 'v1')
    disk.set('/w/a.ts', 'theirs')
    changed('/w/a.ts')
    canvasLifecycle.updateTabContent(id, 'mine')
    await flush()
    expect(tabOf(id)).toMatchObject({ content: 'mine', isDirty: true, diskConflict: true })
  })
})

describe('reverting', () => {
  it('restores the text the file had before editing started', async () => {
    const id = await open('/w/a.ts', 'original')
    canvasLifecycle.updateTabContent(id, 'edit 1')
    canvasLifecycle.updateTabContent(id, 'edit 2')
    canvasLifecycle.revertTabContent(id)
    expect(tabOf(id)).toMatchObject({ content: 'original', isDirty: false })
    expect(tabOf(id).savedContent).toBeUndefined()
  })

  it('holds no second copy of the text once saved', async () => {
    const id = await open('/w/a.ts', 'original')
    canvasLifecycle.updateTabContent(id, 'edit')
    canvasLifecycle.markTabSaved(id, 'edit')
    expect(tabOf(id).savedContent).toBeUndefined()
  })
})
