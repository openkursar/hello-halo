import { beforeEach, describe, expect, it, vi } from 'vitest'

let emitGone: (event: { viewId: string; reason: 'closed' | 'lost' }) => void = () => {}
const createBrowserView = vi.fn(async (_id: string, _url: string) => ({ success: true }))
const showBrowserView = vi.fn(async (_id: string, _bounds: unknown) => ({ success: true }))
const destroyBrowserView = vi.fn(async (id: string) => { emitGone({ viewId: id, reason: 'closed' }); return { success: true } })

vi.mock('../../../../src/renderer/api', () => ({ api: {
  onBrowserStateChange: () => () => {},
  onBrowserPageGone: (callback: typeof emitGone) => { emitGone = callback; return () => {} },
  onArtifactChangedBatch: () => () => {},
  onMemoryPressure: () => () => {},
  getMemoryPressure: async () => 'normal',
  isRemoteMode: () => false,
  createBrowserView: (id: string, url: string) => createBrowserView(id, url),
  showBrowserView: (id: string, bounds: unknown) => showBrowserView(id, bounds),
  hideBrowserView: vi.fn(async () => ({ success: true })),
  destroyBrowserView: (id: string) => destroyBrowserView(id),
} }))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

beforeEach(async () => {
  await canvasLifecycle.closeAll()
  createBrowserView.mockReset().mockImplementation(async () => ({ success: true }))
  showBrowserView.mockReset().mockImplementation(async () => ({ success: true }))
  destroyBrowserView.mockClear()
})

describe('canvas browser page loss', () => {
  it('recreates the active owned page with its existing URL', async () => {
    const id = await canvasLifecycle.openUrl('https://recover.test')
    await flush()
    const viewId = canvasLifecycle.getTab(id)!.browserViewId!
    createBrowserView.mockClear()
    emitGone({ viewId, reason: 'lost' })
    await flush()
    expect(createBrowserView).toHaveBeenCalledWith(expect.any(String), 'https://recover.test')
    expect(canvasLifecycle.getTab(id)!.browserViewId).not.toBe(viewId)
  })

  it('waits to recreate a hidden or collapsed page until it is shown again', async () => {
    const id = await canvasLifecycle.openUrl('https://recover.test')
    await flush()
    const viewId = canvasLifecycle.getTab(id)!.browserViewId!
    await canvasLifecycle.openContent('note', 'Note', 'text')
    createBrowserView.mockClear()
    emitGone({ viewId, reason: 'lost' })
    await flush()
    expect(canvasLifecycle.getTab(id)!.browserViewId).toBeUndefined()
    expect(createBrowserView).not.toHaveBeenCalled()
    await canvasLifecycle.switchTab(id)
    await flush()
    const replacement = canvasLifecycle.getTab(id)!.browserViewId!
    expect(replacement).not.toBe(viewId)
    canvasLifecycle.setOpen(false)
    createBrowserView.mockClear()
    emitGone({ viewId: replacement, reason: 'lost' })
    await flush()
    expect(createBrowserView).not.toHaveBeenCalled()
    canvasLifecycle.setOpen(true)
    await flush()
    expect(createBrowserView).toHaveBeenCalledOnce()
  })

  it('does not revive a page intentionally closed by its canvas tab', async () => {
    const id = await canvasLifecycle.openUrl('https://recover.test')
    await flush()
    createBrowserView.mockClear()
    await canvasLifecycle.closeTab(id)
    await flush()
    expect(destroyBrowserView).toHaveBeenCalledOnce()
    expect(createBrowserView).not.toHaveBeenCalled()
    expect(canvasLifecycle.getTab(id)).toBeUndefined()
  })

  it('leaves AI-owned pages to their owning conversation lifecycle', async () => {
    const id = await canvasLifecycle.attachAIBrowserView('ai-page', 'https://ai.test')
    createBrowserView.mockClear()
    emitGone({ viewId: 'ai-page', reason: 'lost' })
    await flush()
    expect(canvasLifecycle.getTab(id)!.browserViewId).toBe('ai-page')
    expect(createBrowserView).not.toHaveBeenCalled()
  })

  it('retries after the old creation finishes when a page disappears during its initial presentation', async () => {
    let finishShow!: () => void
    showBrowserView.mockImplementationOnce(() => new Promise(resolve => { finishShow = () => resolve({ success: true }) }))
    const releaseBounds = canvasLifecycle.setContainerBoundsGetter(() => ({ x: 10, y: 20, width: 400, height: 300 } as DOMRect))
    const id = await canvasLifecycle.openUrl('https://recover.test')
    await flush()
    const original = canvasLifecycle.getTab(id)!.browserViewId!
    emitGone({ viewId: original, reason: 'lost' })
    finishShow()
    await flush()
    expect(createBrowserView).toHaveBeenCalledTimes(2)
    expect(canvasLifecycle.getTab(id)!.browserViewId).not.toBe(original)
    releaseBounds()
  })
})
