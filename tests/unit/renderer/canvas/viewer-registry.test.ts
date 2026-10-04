/**
 * Every content type has a viewer, and a type the renderer does not know
 * (a newer main process, a stale caller) opens as text instead of a blank pane.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../src/renderer/api', () => ({
  api: {
    isRemoteMode: () => false,
    onBrowserStateChange: () => () => {},
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: () => () => {},
    getMemoryPressure: async () => 'normal',
    detectFileType: vi.fn(async () => ({ success: true, data: { canViewInCanvas: true, contentType: 'hologram' } })),
    readArtifactContent: vi.fn(async () => ({ success: true, data: { content: 'plain' } })),
  },
}))
vi.mock('../../../../src/renderer/i18n', () => ({
  default: { t: (key: string) => key },
  useTranslation: () => ({ t: (key: string) => key }),
}))

// Viewers whose import graphs need a browser or the whole app store; the
// registry only needs a component reference.
vi.mock('../../../../src/renderer/components/canvas/viewers/TerminalViewer', () => ({ TerminalViewer: () => null }))
vi.mock('../../../../src/renderer/components/canvas/viewers/TeamViewer', () => ({ TeamViewer: () => null }))
vi.mock('../../../../src/renderer/components/goal', () => ({ GoalEditor: () => null }))

const { VIEWERS, viewerFor, viewerBringsFileList } = await import('../../../../src/renderer/components/canvas/viewer-registry')
const { CONTENT_TYPES, canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')

describe('viewer registry', () => {
  it('has a viewer for every content type', () => {
    for (const type of CONTENT_TYPES) expect(VIEWERS[type]?.Component, type).toBeDefined()
    expect(Object.keys(VIEWERS).sort()).toEqual([...CONTENT_TYPES].sort())
  })

  it('shows an unknown type with the text viewer', () => {
    expect(viewerFor('hologram')).toBe(VIEWERS.text)
    expect(viewerFor('markdown')).toBe(VIEWERS.markdown)
  })

  it('says which viewers bring their own file list (the page moves its resource rail aside for them)', () => {
    expect(viewerBringsFileList('changes')).toBe(true)
    expect(viewerBringsFileList('code')).toBe(false)
    expect(viewerBringsFileList('hologram')).toBe(false)
  })

  it('opens a file the backend classifies with an unknown type as text', async () => {
    const id = await canvasLifecycle.openFile('/w/file.unknownext')
    expect(canvasLifecycle.getTab(id)!.type).toBe('text')
  })
})
