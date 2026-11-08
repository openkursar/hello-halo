import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TouchPointerController, type TouchPointerRect } from '../../../src/main/services/browser-touch-pointer'

describe('TouchPointerController', () => {
  let page: TouchPointerRect | null
  let focused: boolean
  let cursor: { x: number; y: number }
  let setEmit: ReturnType<typeof vi.fn<[boolean], Promise<void>>>
  let controller: TouchPointerController

  beforeEach(() => {
    vi.useFakeTimers()
    page = { x: 100, y: 50, width: 430, height: 600 }
    focused = true
    cursor = { x: 0, y: 0 }
    setEmit = vi.fn<[boolean], Promise<void>>(async () => {})
    controller = new TouchPointerController({
      getPageBounds: () => page,
      getHost: () => ({ x: 1000, y: 200, zoom: 2, focused }),
      getCursor: () => cursor,
      setEmit,
    })
  })
  afterEach(() => { controller.stop(); vi.useRealTimers() })

  it('never touches the switch while no H5 page is displayed', () => {
    page = null
    controller.sync()
    vi.advanceTimersByTime(1000)
    expect(setEmit).not.toHaveBeenCalled()
  })

  it('turns on only while the cursor is over the page, in zoomed screen coordinates', () => {
    controller.sync()
    expect(setEmit).not.toHaveBeenCalled()
    cursor = { x: 1000 + 101 * 2, y: 200 + 60 * 2 }
    vi.advanceTimersByTime(100)
    expect(setEmit).toHaveBeenLastCalledWith(true)
    vi.advanceTimersByTime(500)
    expect(setEmit).toHaveBeenCalledTimes(1)
    cursor = { x: 1000 + 90 * 2, y: 200 + 60 * 2 }
    vi.advanceTimersByTime(100)
    expect(setEmit).toHaveBeenLastCalledWith(false)
  })

  it('turns off when the page goes away or the window loses focus', () => {
    cursor = { x: 1300, y: 400 }
    controller.sync()
    expect(setEmit).toHaveBeenLastCalledWith(true)
    focused = false
    controller.sync()
    expect(setEmit).toHaveBeenLastCalledWith(false)
    focused = true
    controller.sync()
    expect(setEmit).toHaveBeenLastCalledWith(true)
    page = null
    vi.advanceTimersByTime(100)
    expect(setEmit).toHaveBeenLastCalledWith(false)
    setEmit.mockClear()
    vi.advanceTimersByTime(1000)
    expect(setEmit).not.toHaveBeenCalled()
  })

  it('resends after a failed switch, backing off and warning once while it keeps failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cursor = { x: 1300, y: 400 }
    setEmit.mockRejectedValue(new Error('detached'))
    controller.sync()
    await vi.advanceTimersByTimeAsync(900)
    expect(setEmit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(setEmit).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
    setEmit.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(1100)
    expect(setEmit).toHaveBeenLastCalledWith(true)
    const calls = setEmit.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(setEmit).toHaveBeenCalledTimes(calls)
    warn.mockRestore()
  })
  it('turns off when tracking stops even while backing off, and resends a failed off on its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cursor = { x: 1300, y: 400 }
    controller.sync()
    await vi.advanceTimersByTimeAsync(0)
    expect(setEmit).toHaveBeenLastCalledWith(true)
    setEmit.mockRejectedValueOnce(new Error('detached'))
    cursor = { x: 0, y: 0 }
    await vi.advanceTimersByTimeAsync(100)
    expect(setEmit).toHaveBeenLastCalledWith(false)
    const calls = setEmit.mock.calls.length
    setEmit.mockRejectedValueOnce(new Error('detached'))
    page = null
    controller.sync()
    expect(setEmit).toHaveBeenCalledTimes(calls + 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(setEmit).toHaveBeenCalledTimes(calls + 2)
    expect(setEmit).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(setEmit).toHaveBeenCalledTimes(calls + 2)
    warn.mockRestore()
  })
})
