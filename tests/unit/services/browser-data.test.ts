import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  clearStorageData: vi.fn(), clearCache: vi.fn(), fromPartition: vi.fn(),
  handle: vi.fn(), initialize: vi.fn(), getAllWebContents: vi.fn(),
}))
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(), session: { fromPartition: native.fromPartition },
  webContents: { getAllWebContents: native.getAllWebContents },
  ipcMain: { handle: native.handle },
}))
vi.mock('../../../src/main/services/browser-host', () => ({ browserHostManager: { initialize: native.initialize } }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => ({}), onBrowserConfigChange: vi.fn() }))

import * as browser from '../../../src/main/services/browser-view.service'
import { registerBrowserHandlers } from '../../../src/main/ipc/browser'

beforeEach(() => {
  vi.clearAllMocks()
  native.clearStorageData.mockReset().mockResolvedValue(undefined)
  native.clearCache.mockReset().mockResolvedValue(undefined)
  native.fromPartition.mockReset().mockReturnValue(native)
  native.getAllWebContents.mockReset().mockReturnValue([])
})

function clearData(): Promise<void> {
  expect(browser).toHaveProperty('clearBrowserData', expect.any(Function))
  return browser.clearBrowserData()
}

describe('shared browser data cleanup', () => {
  it('clears all site storage and HTTP cache only in the browser partition', async () => {
    await clearData()
    expect(native.fromPartition.mock.calls).toEqual([['persist:browser']])
    expect(native.clearStorageData.mock.calls).toEqual([[]])
    expect(native.clearCache.mock.calls).toEqual([[]])
  })

  it('reloads every open page on the browser session so it cannot write cleared data back', async () => {
    const page = (session: unknown, destroyed = false) => ({ id: Math.random(), session, isDestroyed: () => destroyed, reload: vi.fn() })
    const loginWindow = page(native)
    const closedPopup = page(native, true)
    const appWindow = page({})
    native.getAllWebContents.mockReturnValue([loginWindow, closedPopup, appWindow])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await clearData()
    expect(loginWindow.reload).toHaveBeenCalledOnce()
    expect(closedPopup.reload).not.toHaveBeenCalled()
    expect(appWindow.reload).not.toHaveBeenCalled()
    expect(native.clearCache.mock.invocationCallOrder[0]).toBeLessThan(native.getAllWebContents.mock.invocationCallOrder[0])
    log.mockRestore()
  })

  it('shares in-flight cleanup and permits another completed request', async () => {
    let finish!: () => void
    native.clearStorageData.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    const first = clearData()
    const second = clearData()
    expect(second).toBe(first)
    finish()
    await Promise.all([first, second])
    expect(native.clearStorageData).toHaveBeenCalledOnce()
    expect(native.clearCache).toHaveBeenCalledOnce()
    await clearData()
    expect(native.clearStorageData).toHaveBeenCalledTimes(2)
  })

  it.each(['clearStorageData', 'clearCache'] as const)('rejects a %s failure and allows retry', async method => {
    native[method].mockRejectedValueOnce(new Error('Native cleanup failed'))
    await expect(clearData()).rejects.toThrow('Native cleanup failed')
    await expect(clearData()).resolves.toBeUndefined()
  })

  it('recovers from a synchronous native session error', async () => {
    native.fromPartition.mockImplementationOnce(() => { throw new Error('Session unavailable') })
    await expect(clearData()).rejects.toThrow('Session unavailable')
    await expect(clearData()).resolves.toBeUndefined()
  })

  it('registers a request that waits for cleanup and reports native failure', async () => {
    registerBrowserHandlers({ on: vi.fn(), webContents: { on: vi.fn() } } as never)
    const handler = native.handle.mock.calls.find(([channel]) => channel === 'browser:clear-data')?.[1]
    expect(handler).toBeTypeOf('function')
    expect(await handler({})).toEqual({ success: true, data: undefined })
    native.clearCache.mockRejectedValueOnce(new Error('Cache unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await handler({})).toMatchObject({ success: false, error: expect.stringContaining('Cache unavailable') })
    expect(log).toHaveBeenCalledOnce()
    log.mockRestore()
  })
})
