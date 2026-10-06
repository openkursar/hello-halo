import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ electron: true, subscribe: vi.fn(), status: vi.fn() }))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => bridge.electron }))
vi.mock('../../../src/renderer/api/system.api', () => ({ systemApi: { onBootstrapExtendedReady: bridge.subscribe, getBootstrapStatus: bridge.status } }))

let ensureReady: typeof import('../../../src/renderer/api/bootstrap-ready')['ensureExtendedServicesReady']
let onReady: () => void
let unsubscribe: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.clearAllMocks()
  bridge.electron = true
  unsubscribe = vi.fn()
  bridge.subscribe.mockImplementation((callback: () => void) => { onReady = callback; return unsubscribe })
  bridge.status.mockResolvedValue({ extendedReady: false })
  ensureReady = (await import('../../../src/renderer/api/bootstrap-ready')).ensureExtendedServicesReady
})

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('desktop extended-service readiness', () => {
  it('subscribes before pulling and shares one pending check and deadline across callers', async () => {
    const order: string[] = []
    bridge.subscribe.mockImplementation((callback: () => void) => { order.push('subscribe'); onReady = callback; return unsubscribe })
    bridge.status.mockImplementation(async () => { order.push('pull'); return { extendedReady: false } })
    const first = ensureReady()
    const second = ensureReady()
    expect(second).toBe(first)
    expect(order).toEqual(['subscribe', 'pull'])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    onReady()
    await Promise.all([first, second])
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(ensureReady()).toBe(first)
    expect(bridge.subscribe).toHaveBeenCalledOnce()
    expect(bridge.status).toHaveBeenCalledOnce()
  })

  it('finishes from an already-ready status and releases its event listener and timer', async () => {
    bridge.status.mockResolvedValueOnce({ extendedReady: true })
    await ensureReady()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    onReady()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('handles an immediate ready event during subscription without losing the returned unsubscribe', async () => {
    bridge.subscribe.mockImplementationOnce((callback: () => void) => { callback(); return unsubscribe })
    await ensureReady()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps success after a ready event wins over a late failed status pull', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejectPull!: (error: Error) => void
    bridge.status.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectPull = reject }))
    const ready = ensureReady()
    onReady()
    await ready
    rejectPull(new Error('late response failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(ensureReady()).toBe(ready)
    expect(warning).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs a rejected status once, cleans up and permits a fresh successful check', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = new Error('bootstrap status unavailable')
    bridge.status.mockRejectedValueOnce(error)
    const first = ensureReady()
    const second = ensureReady()
    expect(second).toBe(first)
    await expect(first).rejects.toBe(error)
    await expect(second).rejects.toBe(error)
    expect(warning).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    bridge.status.mockResolvedValueOnce({ extendedReady: true })
    const retry = ensureReady()
    expect(retry).not.toBe(first)
    await retry
    expect(bridge.status).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a stalled pull, ignores its stale event and retries with a new listener', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bridge.status.mockReturnValueOnce(new Promise(() => {}))
    const first = ensureReady()
    const staleReady = onReady
    const rejected = expect(first).rejects.toThrow('did not become available')
    await vi.advanceTimersByTimeAsync(30000)
    await rejected
    expect(warning).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    let complete = false
    const retry = ensureReady().then(() => { complete = true })
    staleReady()
    await vi.advanceTimersByTimeAsync(0)
    expect(complete).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    onReady()
    await retry
    expect(complete).toBe(true)
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans a synchronous bridge failure without retaining its deadline', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bridge.subscribe.mockImplementationOnce(() => { throw new Error('preload subscription failed') })
    await expect(ensureReady()).rejects.toThrow('preload subscription failed')
    expect(warning).toHaveBeenCalledOnce()
    expect(bridge.status).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not touch desktop IPC or create a timer in remote mode', async () => {
    bridge.electron = false
    await Promise.all([ensureReady(), ensureReady()])
    expect(bridge.subscribe).not.toHaveBeenCalled()
    expect(bridge.status).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
