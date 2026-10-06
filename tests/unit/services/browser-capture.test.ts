import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureBrowserPage, withBrowserFrames } from '../../../src/main/services/browser-host'

const empty = { isEmpty: () => true }
const painted = { isEmpty: () => false }

class CaptureContents extends EventEmitter {
  id = 1
  destroyed = false
  throttling = true
  isDestroyed = () => this.destroyed
  getBackgroundThrottling = () => this.throttling
  setBackgroundThrottling = vi.fn((value: boolean) => { this.throttling = value })
  capturePage = vi.fn().mockResolvedValue(painted)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('browser frame capture', () => {
  it('retries an empty surface and returns the first painted frame', async () => {
    const contents = new CaptureContents()
    contents.capturePage.mockResolvedValueOnce(empty)
    const request = captureBrowserPage(contents as never, undefined, 100)
    await vi.advanceTimersByTimeAsync(25)
    expect(await request).toBe(painted)
    expect(contents.capturePage).toHaveBeenCalledTimes(2)
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries only transient unavailable-surface failures', async () => {
    const contents = new CaptureContents()
    contents.capturePage.mockRejectedValueOnce(new Error('The display surface is not available for capture'))
    const request = captureBrowserPage(contents as never, undefined, 100)
    await vi.advanceTimersByTimeAsync(25)
    expect(await request).toBe(painted)
    expect(contents.capturePage).toHaveBeenCalledTimes(2)
  })

  it('rejects permanent native errors without retrying or retaining a deadline', async () => {
    const contents = new CaptureContents()
    contents.capturePage.mockRejectedValueOnce(new Error('Renderer process lost'))
    await expect(captureBrowserPage(contents as never, undefined, 100)).rejects.toThrow('Renderer process lost')
    expect(contents.capturePage).toHaveBeenCalledOnce()
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds native captures that never settle and restores the original background policy', async () => {
    const contents = new CaptureContents()
    contents.capturePage.mockReturnValueOnce(new Promise(() => {}))
    const request = captureBrowserPage(contents as never, undefined, 100)
    const rejected = expect(request).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an already closed page before requesting native capture', async () => {
    const contents = new CaptureContents()
    contents.destroyed = true
    await expect(captureBrowserPage(contents as never, undefined, 100)).rejects.toThrow('closed')
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves an existing unthrottled policy after successful capture', async () => {
    const contents = new CaptureContents()
    contents.throttling = false
    expect(await captureBrowserPage(contents as never, undefined, 100)).toBe(painted)
    expect(contents.throttling).toBe(false)
    expect(contents.setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('releases frames on cancellation without retrying a late empty native capture', async () => {
    const contents = new CaptureContents()
    const controller = new AbortController()
    let finish!: (image: typeof empty) => void
    contents.capturePage.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const request = captureBrowserPage(contents as never, undefined, 1000, { signal: controller.signal })
    const rejected = expect(request).rejects.toThrow('scope ended')
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.capturePage).toHaveBeenCalledOnce()
    controller.abort(new Error('scope ended'))
    await rejected
    expect(contents.throttling).toBe(true)
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    finish(empty)
    await vi.advanceTimersByTimeAsync(50)
    expect(contents.capturePage).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry a late unavailable-surface error after cancellation', async () => {
    const contents = new CaptureContents()
    const controller = new AbortController()
    let refuse!: (error: Error) => void
    contents.capturePage.mockReturnValueOnce(new Promise((_resolve, reject) => { refuse = reject }))
    const request = captureBrowserPage(contents as never, undefined, 1000, { signal: controller.signal })
    const rejected = expect(request).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('cancelled'))
    await rejected
    refuse(new Error('The display surface is not available for capture'))
    await vi.advanceTimersByTimeAsync(50)
    expect(contents.capturePage).toHaveBeenCalledOnce()
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a destroyed guest immediately even when native capture never settles', async () => {
    const contents = new CaptureContents()
    contents.capturePage.mockReturnValueOnce(new Promise(() => {}))
    const request = captureBrowserPage(contents as never, undefined, 1000)
    const rejected = expect(request).rejects.toThrow('page closed')
    await vi.advanceTimersByTimeAsync(0)
    contents.destroyed = true
    contents.emit('destroyed')
    await rejected
    expect(contents.capturePage).toHaveBeenCalledOnce()
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps shared frame production enabled until both overlapping operations end', async () => {
    const contents = new CaptureContents()
    let finishFirst!: (result: string) => void
    let finishSecond!: (result: string) => void
    const first = withBrowserFrames(contents as never, () => new Promise<string>(resolve => { finishFirst = resolve }))
    const second = withBrowserFrames(contents as never, () => new Promise<string>(resolve => { finishSecond = resolve }))
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    finishFirst('first')
    expect(await first).toBe('first')
    expect(contents.throttling).toBe(false)
    finishSecond('second')
    expect(await second).toBe('second')
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
  })

  it('releases a failed operation and does not access a guest after it was destroyed', async () => {
    const contents = new CaptureContents()
    await expect(withBrowserFrames(contents as never, async () => {
      contents.destroyed = true
      throw new Error('page closed')
    })).rejects.toThrow('page closed')
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false]])
  })
})
