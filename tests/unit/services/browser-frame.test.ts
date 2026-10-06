import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { withBrowserFrames } from '../../../src/main/services/browser-host'

const host = vi.hoisted(() => ({ prepareFrames: vi.fn() }))
vi.mock('../../../src/main/services/browser-host/manager', () => ({ browserHostManager: host }))

class FrameContents extends EventEmitter {
  id = 17
  destroyed = false
  throttling = true
  isDestroyed = () => this.destroyed
  getBackgroundThrottling = () => this.throttling
  setBackgroundThrottling = vi.fn((value: boolean) => { this.throttling = value })
}

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
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

describe('browser frame callers', () => {
  it('does not allocate frames for a pre-aborted caller or an expired deadline', async () => {
    const contents = new FrameContents()
    const controller = new AbortController()
    const reason = new Error('caller released')
    controller.abort(reason)
    const operation = vi.fn()
    const cleanup = vi.fn()
    await expect(withBrowserFrames(contents as never, operation, 100, { signal: controller.signal, beforeRelease: cleanup })).rejects.toBe(reason)
    await expect(withBrowserFrames(contents as never, operation, 100, { deadline: Date.now() })).rejects.toThrow('timed out')
    expect(operation).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(host.prepareFrames).not.toHaveBeenCalled()
    expect(contents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives overlapping short and long callers independent preparation deadlines', async () => {
    const contents = new FrameContents()
    const preparation = pending<() => void>()
    const release = vi.fn()
    host.prepareFrames.mockReturnValueOnce(preparation.promise)
    const shortOperation = vi.fn(async () => 'short')
    const longOperation = vi.fn(async () => 'long')
    const short = withBrowserFrames(contents as never, shortOperation, 10)
    const rejected = expect(short).rejects.toThrow('preparation timed out')
    const long = withBrowserFrames(contents as never, longOperation, 100)
    await vi.advanceTimersByTimeAsync(10)
    await rejected
    expect(shortOperation).not.toHaveBeenCalled()
    expect(contents.throttling).toBe(false)
    const signal = host.prepareFrames.mock.calls[0][2] as AbortSignal
    expect(signal.aborted).toBe(false)
    preparation.resolve(release)
    expect(await long).toBe('long')
    expect(host.prepareFrames).toHaveBeenCalledOnce()
    expect(longOperation).toHaveBeenCalledOnce()
    expect(signal.aborted).toBe(true)
    expect(release).toHaveBeenCalledOnce()
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels host preparation immediately when its last caller aborts before readiness', async () => {
    const contents = new FrameContents()
    const controller = new AbortController()
    const preparation = pending<() => void>()
    host.prepareFrames.mockImplementationOnce((_contents, _timeout, signal: AbortSignal) => {
      signal.addEventListener('abort', () => preparation.reject(signal.reason), { once: true })
      return preparation.promise
    })
    const operation = vi.fn()
    const request = withBrowserFrames(contents as never, operation, 100, { signal: controller.signal })
    const rejected = expect(request).rejects.toThrow('scope ended')
    controller.abort(new Error('scope ended'))
    await rejected
    expect((host.prepareFrames.mock.calls[0][2] as AbortSignal).aborted).toBe(true)
    expect(operation).not.toHaveBeenCalled()
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(await withBrowserFrames(contents as never, async () => 'new caller')).toBe('new caller')
    expect(host.prepareFrames).toHaveBeenCalledTimes(2)
  })

  it('does not release another caller when one pending operation aborts', async () => {
    const contents = new FrameContents()
    const controller = new AbortController()
    const firstWork = pending<string>()
    const secondWork = pending<string>()
    const release = vi.fn()
    host.prepareFrames.mockResolvedValueOnce(release)
    const first = withBrowserFrames(contents as never, () => firstWork.promise, 100, { signal: controller.signal })
    const rejected = expect(first).rejects.toThrow('cancel first')
    const second = withBrowserFrames(contents as never, () => secondWork.promise, 100)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('cancel first'))
    await rejected
    expect(contents.throttling).toBe(false)
    expect(release).not.toHaveBeenCalled()
    secondWork.resolve('second')
    expect(await second).toBe('second')
    expect(release).toHaveBeenCalledOnce()
    expect(contents.throttling).toBe(true)
    firstWork.resolve('late native completion')
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('includes preparation and pending work in the absolute deadline', async () => {
    const contents = new FrameContents()
    const preparation = pending<() => void>()
    const work = pending<string>()
    const release = vi.fn()
    const cleanup = vi.fn(async () => { expect(contents.throttling).toBe(false) })
    host.prepareFrames.mockReturnValueOnce(preparation.promise)
    const request = withBrowserFrames(contents as never, () => work.promise, 100, { deadline: Date.now() + 60, beforeRelease: cleanup })
    const rejected = expect(request).rejects.toThrow('operation timed out')
    await vi.advanceTimersByTimeAsync(40)
    preparation.resolve(release)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(cleanup).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds frames until successful pressed-input cleanup finishes', async () => {
    const contents = new FrameContents()
    const cleanup = pending<void>()
    const release = vi.fn()
    host.prepareFrames.mockResolvedValueOnce(release)
    const beforeRelease = vi.fn(() => {
      expect(contents.throttling).toBe(false)
      return cleanup.promise
    })
    const request = withBrowserFrames(contents as never, async () => 'completed', 100, { beforeRelease })
    await vi.advanceTimersByTimeAsync(0)
    expect(beforeRelease).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    expect(contents.throttling).toBe(false)
    cleanup.resolve()
    expect(await request).toBe('completed')
    expect(release).toHaveBeenCalledOnce()
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans only the aborted caller while an overlapping caller keeps its frames', async () => {
    const contents = new FrameContents()
    const controller = new AbortController()
    const work = pending<string>()
    const secondWork = pending<string>()
    const cleanup = vi.fn(async () => { expect(contents.throttling).toBe(false) })
    const release = vi.fn()
    host.prepareFrames.mockResolvedValueOnce(release)
    const first = withBrowserFrames(contents as never, () => work.promise, 100, { signal: controller.signal, beforeRelease: cleanup })
    const rejected = expect(first).rejects.toThrow('cancel input')
    const second = withBrowserFrames(contents as never, () => secondWork.promise, 100)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('cancel input'))
    await rejected
    expect(cleanup).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    expect(contents.throttling).toBe(false)
    secondWork.resolve('second')
    expect(await second).toBe('second')
    expect(release).toHaveBeenCalledOnce()
  })

  it('preserves an operation error when pressed-input cleanup also fails', async () => {
    const contents = new FrameContents()
    const operationError = new Error('native command failed')
    const cleanupError = new Error('key release failed')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cleanup = vi.fn(async () => { throw cleanupError })
    await expect(withBrowserFrames(contents as never, async () => { throw operationError }, 100, { beforeRelease: cleanup })).rejects.toBe(operationError)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledOnce()
    expect(warning.mock.calls[0]).toEqual(['[BrowserFrame] Failed to release pressed input', { contentsId: contents.id }, cleanupError])
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds cleanup that never settles and preserves the completed operation result', async () => {
    const contents = new FrameContents()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cleanup = vi.fn(() => new Promise<void>(() => {}))
    const request = withBrowserFrames(contents as never, async () => 'completed', 100, { beforeRelease: cleanup })
    await vi.advanceTimersByTimeAsync(499)
    expect(contents.throttling).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await request).toBe('completed')
    expect(warning).toHaveBeenCalledOnce()
    expect(warning.mock.calls[0][2]).toMatchObject({ message: 'Browser input cleanup timed out' })
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('skips native cleanup and policy access after the guest is destroyed', async () => {
    const contents = new FrameContents()
    const cleanup = vi.fn(async () => {})
    expect(await withBrowserFrames(contents as never, async () => { contents.destroyed = true; return 'closed' }, 100, { beforeRelease: cleanup })).toBe('closed')
    expect(cleanup).not.toHaveBeenCalled()
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a pending operation immediately on guest destruction and removes its listener', async () => {
    const contents = new FrameContents()
    const cleanup = vi.fn(async () => {})
    const release = vi.fn()
    host.prepareFrames.mockResolvedValueOnce(release)
    const request = withBrowserFrames(contents as never, () => new Promise<string>(() => {}), 100, { beforeRelease: cleanup })
    const rejected = expect(request).rejects.toThrow('page closed during operation')
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.listenerCount('destroyed')).toBe(1)
    contents.destroyed = true
    contents.emit('destroyed')
    await rejected
    expect(cleanup).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the original unthrottled policy through failure and cleanup', async () => {
    const contents = new FrameContents()
    contents.throttling = false
    const cleanup = vi.fn(async () => {})
    await expect(withBrowserFrames(contents as never, async () => { throw new Error('failed') }, 100, { beforeRelease: cleanup })).rejects.toThrow('failed')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(contents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(contents.throttling).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('prepares again for a caller that joins while a failed caller is still cleaning up', async () => {
    const contents = new FrameContents()
    const failedPreparation = pending<() => void>()
    const cleanupGate = pending<void>()
    const release = vi.fn()
    host.prepareFrames.mockReturnValueOnce(failedPreparation.promise).mockResolvedValueOnce(release)
    const failing = withBrowserFrames(contents as never, async () => 'never', 1000, { beforeRelease: () => cleanupGate.promise })
    const failed = expect(failing).rejects.toThrow('host restarting')
    failedPreparation.reject(new Error('host restarting'))
    await vi.advanceTimersByTimeAsync(0)

    await expect(withBrowserFrames(contents as never, async () => 'joined', 1000)).resolves.toBe('joined')
    expect(host.prepareFrames).toHaveBeenCalledTimes(2)
    expect(release).not.toHaveBeenCalled()

    cleanupGate.resolve()
    await failed
    expect(release).toHaveBeenCalledOnce()
    expect(contents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
