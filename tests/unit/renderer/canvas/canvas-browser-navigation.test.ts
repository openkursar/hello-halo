import { beforeEach, describe, expect, it, vi } from 'vitest'

const createBrowserView = vi.fn(async (_id: string, _url: string) => ({ success: true }))
const navigateBrowserView = vi.fn(async (_id: string, _url: string) => ({ success: true }))
const destroyBrowserView = vi.fn(async (_id: string) => ({ success: true }))

vi.mock('../../../../src/renderer/api', () => ({ api: {
  onBrowserStateChange: () => () => {}, onBrowserPageGone: () => () => {},
  onArtifactChangedBatch: () => () => {}, onMemoryPressure: () => () => {},
  getMemoryPressure: async () => 'normal', isRemoteMode: () => false,
  createBrowserView: (id: string, url: string) => createBrowserView(id, url),
  navigateBrowserView: (id: string, url: string) => navigateBrowserView(id, url),
  destroyBrowserView: (id: string) => destroyBrowserView(id),
  hideBrowserView: vi.fn(async () => ({ success: true })),
  showBrowserView: vi.fn(async () => ({ success: true })),
} }))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

function holdCreation() {
  let finish!: () => void
  createBrowserView.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ success: true }) }))
  return () => finish()
}

beforeEach(async () => {
  await canvasLifecycle.closeAll()
  createBrowserView.mockReset().mockResolvedValue({ success: true })
  navigateBrowserView.mockClear()
  destroyBrowserView.mockClear()
})

describe('navigation while a guest is being created', () => {
  it('delivers the first submitted address after its guest becomes ready', async () => {
    const finish = holdCreation()
    const id = await canvasLifecycle.openUrl('https://homepage.test')
    const navigation = canvasLifecycle.navigateBrowserTab(id, 'https://requested.test')
    expect(navigateBrowserView).not.toHaveBeenCalled()
    finish()
    await navigation
    expect(navigateBrowserView).toHaveBeenCalledWith(canvasLifecycle.getTab(id)!.browserViewId, 'https://requested.test')
    expect(createBrowserView).toHaveBeenCalledOnce()
  })

  it('navigates the originally submitted tab when the user switches away while waiting', async () => {
    const finish = holdCreation()
    const id = await canvasLifecycle.openUrl('https://homepage.test')
    const navigation = canvasLifecycle.navigateBrowserTab(id, 'https://requested.test')
    const note = await canvasLifecycle.openContent('note', 'Note', 'text')
    finish()
    await navigation
    expect(navigateBrowserView).toHaveBeenCalledWith(canvasLifecycle.getTab(id)!.browserViewId, 'https://requested.test')
    expect(canvasLifecycle.getActiveTabId()).toBe(note)
  })

  it('cancels navigation to a closed tab and destroys its late guest', async () => {
    const finish = holdCreation()
    const id = await canvasLifecycle.openUrl('https://homepage.test')
    const navigation = canvasLifecycle.navigateBrowserTab(id, 'https://requested.test')
    await canvasLifecycle.closeTab(id)
    finish()
    await navigation
    await flush()
    expect(navigateBrowserView).not.toHaveBeenCalled()
    expect(destroyBrowserView).toHaveBeenCalledWith(createBrowserView.mock.calls[0][0])
  })
})
