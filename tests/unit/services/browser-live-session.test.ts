import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserLiveSession } from '../../../src/main/services/browser-live/session'
import type { BrowserLiveFrame, BrowserLiveStopped } from '../../../src/shared/types/browser-live'

const host = vi.hoisted(() => ({ prepareFrames: vi.fn() }))
vi.mock('../../../src/main/services/browser-host/manager', () => ({ browserHostManager: host }))
const fullPage = vi.hoisted(() => ({ captureFullPage: vi.fn() }))
vi.mock('../../../src/main/services/browser-live/full-page', () => fullPage)

function image(payload: string, width = 1280, height = 800): Electron.NativeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: ({ width: target }: { width: number }) => image(payload, target, Math.round((height * target) / width)),
    toJPEG: () => Buffer.from(payload),
    toPNG: () => Buffer.from(`png:${payload}`),
  } as unknown as Electron.NativeImage
}

class LiveContents extends EventEmitter {
  id = 42
  destroyed = false
  throttling = true
  isDestroyed = () => this.destroyed
  getURL = () => 'https://example.com/login'
  getBackgroundThrottling = () => this.throttling
  setBackgroundThrottling = vi.fn((value: boolean) => { this.throttling = value })
  capturePage = vi.fn(async () => image('frame-a'))
  sendInputEvent = vi.fn()
  getZoomFactor = () => 1
  executeJavaScriptInIsolatedWorld = vi.fn(async () => [1280, 800, 400, 3000])
}

function viewer(viewerId = 'client-1', deliver: () => boolean = () => true) {
  const frames: BrowserLiveFrame[] = []
  const stops: BrowserLiveStopped[] = []
  return {
    frames,
    stops,
    link: {
      viewerId,
      frame: (frame: BrowserLiveFrame) => {
        frames.push(frame)
        return deliver()
      },
      stopped: (event: BrowserLiveStopped) => { stops.push(event) },
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  host.prepareFrames.mockReset()
  host.prepareFrames.mockResolvedValue(vi.fn())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('browser live session', () => {
  it('streams only while someone watches, and restores the page background policy after', async () => {
    const contents = new LiveContents()
    const empty = vi.fn()
    const session = new BrowserLiveSession('view-1', contents as never, empty)
    const watcher = viewer()

    expect(contents.capturePage).not.toHaveBeenCalled()

    session.addViewer(watcher.link)
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.throttling).toBe(false)
    expect(watcher.frames).toHaveLength(1)
    expect(watcher.frames[0]).toMatchObject({ viewId: 'view-1', seq: 1, width: 1024, url: 'https://example.com/login' })
    expect(watcher.frames[0].image.startsWith('data:image/jpeg;base64,')).toBe(true)

    session.removeViewer('client-1')
    await vi.advanceTimersByTimeAsync(250)
    expect(contents.throttling).toBe(true)
    expect(empty).toHaveBeenCalledWith('view-1')
    const before = contents.capturePage.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(contents.capturePage.mock.calls.length).toBe(before)
  })

  it('paces captures and sends nothing while the page is unchanged', async () => {
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)

    await vi.advanceTimersByTimeAsync(0)
    expect(watcher.frames).toHaveLength(1)

    session.ack('client-1', 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(watcher.frames).toHaveLength(1)
    expect(session.stats().suppressed).toBeGreaterThan(0)
    expect(session.stats().frames).toBe(1)

    contents.capturePage.mockResolvedValue(image('frame-b'))
    await vi.advanceTimersByTimeAsync(250)
    expect(watcher.frames).toHaveLength(2)
    expect(watcher.frames[1].seq).toBe(2)

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('stops sending to a viewer that owes frames and resumes on its acknowledgement', async () => {
    const contents = new LiveContents()
    let payload = 0
    contents.capturePage.mockImplementation(async () => image(`frame-${payload++}`))
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)

    await vi.advanceTimersByTimeAsync(2000)
    expect(watcher.frames).toHaveLength(2)

    session.ack('client-1', 2)
    await vi.advanceTimersByTimeAsync(250)
    expect(watcher.frames).toHaveLength(3)

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('does not capture faster when frames are acknowledged quickly', async () => {
    const contents = new LiveContents()
    let n = 0
    contents.capturePage.mockImplementation(async () => image(`frame-${n++}`))
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)
    await vi.advanceTimersByTimeAsync(0)
    session.ack('client-1', 1)
    await vi.advanceTimersByTimeAsync(249)
    expect(contents.capturePage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(contents.capturePage).toHaveBeenCalledTimes(2)
    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('drops a viewer that stops acknowledging', async () => {
    const contents = new LiveContents()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let payload = 0
    contents.capturePage.mockImplementation(async () => image(`frame-${payload++}`))
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)

    await vi.advanceTimersByTimeAsync(11_000)
    expect(watcher.stops).toEqual([{ viewId: 'view-1', reason: 'stalled' }])
    expect(session.viewerCount).toBe(0)
    expect(contents.throttling).toBe(true)
  })

  it('keeps a viewer that waited on an unchanged page when the page finally changes', async () => {
    const contents = new LiveContents()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)
    await vi.advanceTimersByTimeAsync(0)
    session.ack('client-1', 1)

    await vi.advanceTimersByTimeAsync(30_000)
    contents.capturePage.mockResolvedValue(image('frame-b'))
    await vi.advanceTimersByTimeAsync(1000)

    expect(watcher.stops).toHaveLength(0)
    expect(watcher.frames).toHaveLength(2)
    expect(session.viewerCount).toBe(1)

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('serves a full-resolution still without spending the viewer stream budget', async () => {
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)
    await vi.advanceTimersByTimeAsync(0)
    watcher.frames.length = 0

    session.requestDetail('client-1')
    await vi.advanceTimersByTimeAsync(250)
    const detail = watcher.frames.find(frame => frame.detail)
    expect(detail).toMatchObject({ detail: true, width: 1280, height: 800 })
    expect(detail?.image.startsWith('data:image/png;base64,')).toBe(true)
    expect(session.stats().frames).toBe(1)

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('serves the whole page on request, placed within the document and outside the stream budget', async () => {
    fullPage.captureFullPage.mockResolvedValueOnce({ image: 'data:image/jpeg;base64,cGFnZQ==', width: 1024, height: 4000, covered: 5000, total: 5000 })
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)
    await vi.advanceTimersByTimeAsync(0)

    session.requestDetail('client-1', 'page')
    await vi.advanceTimersByTimeAsync(250)
    expect(watcher.frames.find(frame => frame.detail)).toMatchObject({
      detail: true, width: 1024, height: 4000, page: { top: 0, height: 5000, total: 5000 },
    })
    expect(session.stats().frames).toBe(1)

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('answers a whole-page request with the screen, placed in the page, when the page cannot be captured whole', async () => {
    fullPage.captureFullPage.mockRejectedValueOnce(new Error('no compositor frame'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)
    await vi.advanceTimersByTimeAsync(0)

    session.requestDetail('client-1', 'page')
    await vi.advanceTimersByTimeAsync(250)
    const still = watcher.frames.find(frame => frame.detail)
    expect(still).toMatchObject({ width: 1024, page: { top: 400, height: 800, total: 3000 } })
    expect(still?.image.startsWith('data:image/jpeg;base64,')).toBe(true)

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('forgets a viewer whose link refuses a frame', async () => {
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer('client-1', () => false)
    session.addViewer(watcher.link)

    await vi.advanceTimersByTimeAsync(250)
    expect(session.viewerCount).toBe(0)
    expect(watcher.stops).toHaveLength(0)
  })

  it('streams once the first commit lands after an early viz error', async () => {
    const contents = new LiveContents()
    contents.capturePage.mockRejectedValueOnce(new Error('UnknownVizError'))
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)

    await vi.advanceTimersByTimeAsync(250)
    expect(watcher.stops).toHaveLength(0)
    expect(watcher.frames).toHaveLength(1)

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('reports a page that never yields a frame instead of waiting forever', async () => {
    const contents = new LiveContents()
    contents.capturePage.mockRejectedValue(new Error('UnknownVizError'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const empty = vi.fn()
    const session = new BrowserLiveSession('view-1', contents as never, empty)
    const watcher = viewer()
    session.addViewer(watcher.link)

    await vi.advanceTimersByTimeAsync(9_000)
    expect(watcher.stops).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(watcher.stops).toEqual([{ viewId: 'view-1', reason: 'unavailable' }])
    expect(empty).toHaveBeenCalledWith('view-1')
    expect(contents.throttling).toBe(true)
  })

  it('tells every viewer why a closed page stopped streaming', async () => {
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const first = viewer('client-1')
    const second = viewer('client-2')
    session.addViewer(first.link)
    session.addViewer(second.link)
    await vi.advanceTimersByTimeAsync(0)

    contents.destroyed = true
    session.stop('gone')
    await vi.advanceTimersByTimeAsync(250)

    expect(first.stops).toEqual([{ viewId: 'view-1', reason: 'gone' }])
    expect(second.stops).toEqual([{ viewId: 'view-1', reason: 'gone' }])
    expect(session.viewerCount).toBe(0)
  })

  it('polls a page that sits still slowly, and quickly again once the viewer acts', async () => {
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)
    await vi.advanceTimersByTimeAsync(0)
    session.ack('client-1', 1)

    await vi.advanceTimersByTimeAsync(5000)
    const idle = contents.capturePage.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(contents.capturePage.mock.calls.length - idle).toBeLessThanOrEqual(2)

    expect(session.input('client-1', { kind: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left', clickCount: 1 })).toBe(true)
    const acted = contents.capturePage.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(contents.capturePage.mock.calls.length - acted).toBeGreaterThanOrEqual(8)

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('aims input at the page in its own size and tells the viewer where the frame sits', async () => {
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()

    expect(session.input('client-1', { kind: 'mouse', action: 'down', x: 0.5, y: 0.5 })).toBe(false)
    session.addViewer(watcher.link)
    await vi.advanceTimersByTimeAsync(0)
    expect(watcher.frames[0].scroll).toEqual({ top: 400, viewport: 800, total: 3000 })

    session.input('client-1', { kind: 'mouse', action: 'down', x: 0.5, y: 0.25, button: 'left', clickCount: 1 })
    session.input('client-1', { kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 })
    expect(session.input('client-2', { kind: 'mouse', action: 'up', x: 0, y: 0 })).toBe(false)
    await vi.advanceTimersByTimeAsync(0)

    expect(contents.sendInputEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'mouseDown', x: 640, y: 200, button: 'left' }))
    expect(contents.sendInputEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'mouseWheel', x: 640, y: 400, deltaY: -400 }))

    session.input('client-1', { kind: 'scroll-to', top: 1200 })
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(expect.any(Number), [{ code: "scrollTo({ top: 1200, behavior: 'instant' })" }])

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('drops a queued action if the attachment is no longer authorized at dispatch', async () => {
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    let current = true
    session.addViewer({ ...viewer().link, isCurrent: () => current })
    await vi.advanceTimersByTimeAsync(0)

    expect(session.input('client-1', { kind: 'mouse', action: 'down', x: 0.1, y: 0.1, button: 'left', clickCount: 1 })).toBe(true)
    current = false
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.sendInputEvent).not.toHaveBeenCalled()

    session.removeViewer('client-1')
    await vi.advanceTimersByTimeAsync(250)
    expect(contents.throttling).toBe(true)
  })

  it('lets go of whatever a departing viewer still held', async () => {
    const contents = new LiveContents()
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    session.addViewer(viewer().link)
    await vi.advanceTimersByTimeAsync(0)

    session.input('client-1', { kind: 'mouse', action: 'down', x: 0.1, y: 0.1, button: 'left', clickCount: 1 })
    session.input('client-1', { kind: 'mouse', action: 'move', x: 0.2, y: 0.2 })
    await vi.advanceTimersByTimeAsync(0)
    session.removeViewer('client-1')
    await vi.advanceTimersByTimeAsync(0)

    expect(contents.sendInputEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'mouseMove', modifiers: ['leftbuttondown'] }))
    expect(contents.sendInputEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'mouseUp', x: 256, y: 160, button: 'left' }))
    await vi.advanceTimersByTimeAsync(250)
  })

  it('still streams a page too busy to be measured', async () => {
    const contents = new LiveContents()
    contents.executeJavaScriptInIsolatedWorld.mockImplementation(() => new Promise(() => {}))
    const session = new BrowserLiveSession('view-1', contents as never, vi.fn())
    const watcher = viewer()
    session.addViewer(watcher.link)
    await vi.advanceTimersByTimeAsync(400)

    expect(watcher.frames).toHaveLength(1)
    expect(watcher.frames[0].scroll).toBeUndefined()
    expect(session.input('client-1', { kind: 'mouse', action: 'move', x: 0.5, y: 0.5 })).toBe(true)

    session.stop('gone')
    await vi.advanceTimersByTimeAsync(0)
  })
})
