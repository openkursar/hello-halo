/**
 * The canvas keeps its space watched while a tab shows a file, so open files
 * keep refreshing and detecting disk conflicts after the file tree unmounts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const retainArtifactSpace = vi.fn(async (_spaceId: string, _clientId: string) => ({ success: true, data: { recreated: false } }))
const releaseArtifactSpace = vi.fn(async (_spaceId: string, _clientId: string) => ({ success: true }))

vi.mock('../../../../src/renderer/api', () => ({
  api: {
    onBrowserStateChange: () => () => {},
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: () => () => {},
    getMemoryPressure: async () => 'normal',
    readArtifactContent: async () => ({ success: true, data: { content: 'x', mimeType: 'text/plain' } }),
    isRemoteMode: () => false,
    hideBrowserView: vi.fn(async () => ({ success: true })),
    retainArtifactSpace: (spaceId: string, clientId: string) => retainArtifactSpace(spaceId, clientId),
    releaseArtifactSpace: (spaceId: string, clientId: string) => releaseArtifactSpace(spaceId, clientId),
    emitLocalArtifactChangedBatch: vi.fn(),
  },
}))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')

const retainedSpaces = () => retainArtifactSpace.mock.calls.map(call => call[0])
const releasedSpaces = () => releaseArtifactSpace.mock.calls.map(call => call[0])

beforeEach(async () => {
  await canvasLifecycle.closeAll()
  await canvasLifecycle.enterSpace('space-a')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.advanceTimersByTime(60_000)
  retainArtifactSpace.mockClear()
  releaseArtifactSpace.mockClear()
})

afterEach(async () => {
  vi.useRealTimers()
  await canvasLifecycle.closeAll()
})

describe('canvas space hold', () => {
  it('holds the space while a file tab is open and releases it after the last one closes', async () => {
    const id = await canvasLifecycle.openFile('/w/a.ts')
    expect(retainedSpaces()).toEqual(['space-a'])

    await canvasLifecycle.openFile('/w/b.ts')
    expect(retainedSpaces()).toEqual(['space-a'])

    await canvasLifecycle.closeAll()
    vi.advanceTimersByTime(10_000)
    expect(releasedSpaces()).toEqual(['space-a'])
    expect(id).toBeTruthy()
  })

  it('takes no hold for tabs without a file', async () => {
    await canvasLifecycle.openContent('text', 'Note', 'text')
    expect(retainArtifactSpace).not.toHaveBeenCalled()
  })

  it('moves the hold with a space switch', async () => {
    await canvasLifecycle.openFile('/w/a.ts')
    await canvasLifecycle.enterSpace('space-b')
    vi.advanceTimersByTime(10_000)
    expect(releasedSpaces()).toEqual(['space-a'])

    await canvasLifecycle.openFile('/w/c.ts')
    expect(retainedSpaces()).toEqual(['space-a', 'space-b'])
  })
})
