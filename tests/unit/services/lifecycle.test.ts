/**
 * App lifecycle: a relaunch persists its reason and never records a clean exit;
 * closing the last window keeps the process alive for background work unless a
 * quit is under way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const recordSessionExitReason = vi.fn()
const markSessionCleanExit = vi.fn()
vi.mock('../../../src/main/foundation/session-integrity', () => ({
  recordSessionExitReason: (reason: string) => recordSessionExitReason(reason),
  markSessionCleanExit: () => markSessionCleanExit(),
}))
vi.mock('../../../src/main/foundation/logging', () => ({ logFatal: vi.fn() }))
const writePreCrashSnapshot = vi.fn()
vi.mock('../../../src/main/services/perf', () => ({
  writePreCrashSnapshot: (reason: string) => writePreCrashSnapshot(reason),
}))
const setTrayNotice = vi.fn()
vi.mock('../../../src/main/platform/background', () => ({
  getBackgroundService: () => ({ setTrayNotice }),
}))

const relaunch = vi.fn()
const exit = vi.fn()
const showMessageBox = vi.fn()
vi.mock('electron', () => ({
  app: { relaunch: () => relaunch(), exit: (code: number) => exit(code), isReady: () => true },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
  Notification: Object.assign(vi.fn(() => ({ show: vi.fn() })), { isSupported: () => false }),
}))

import {
  announceRendererHalted,
  decideAllWindowsClosed,
  relaunchApp,
} from '../../../src/main/services/lifecycle'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('relaunchApp', () => {
  it('records the reason before relaunching and never marks the session clean', () => {
    relaunchApp('renderer-recovery')

    expect(recordSessionExitReason).toHaveBeenCalledWith('renderer-recovery')
    expect(writePreCrashSnapshot).toHaveBeenCalledWith('relaunch')
    expect(markSessionCleanExit).not.toHaveBeenCalled()
    expect(recordSessionExitReason.mock.invocationCallOrder[0])
      .toBeLessThan(relaunch.mock.invocationCallOrder[0])
    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('announceRendererHalted', () => {
  it('pins a tray notice and asks the user, without relaunching by itself', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })

    announceRendererHalted(null, 'render-process-gone:oom', 4)
    await Promise.resolve()
    await Promise.resolve()

    expect(setTrayNotice).toHaveBeenCalledTimes(1)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('relaunches with a persisted reason only when the user picks Restart', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })

    announceRendererHalted(null, 'render-process-gone:crashed', 4)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(recordSessionExitReason).toHaveBeenCalledWith('user-restart-after-renderer-halt')
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('the tray action relaunches through the same recorded path', () => {
    showMessageBox.mockReturnValue(new Promise(() => {}))
    announceRendererHalted(null, 'unresponsive', 4)

    const notice = setTrayNotice.mock.calls[0][0] as { onAction: () => void }
    notice.onAction()

    expect(recordSessionExitReason).toHaveBeenCalledWith('user-restart-after-renderer-halt')
    expect(relaunch).toHaveBeenCalledTimes(1)
  })
})

describe('decideAllWindowsClosed', () => {
  const base = { serverMode: false, platform: 'win32' as NodeJS.Platform, quitting: false, keepAlive: false, windowRecreated: false, trayAvailable: true }

  it('quits on a real quit', () => {
    expect(decideAllWindowsClosed({ ...base, quitting: true, keepAlive: true })).toBe('quit')
  })

  it('on Windows stays alive for background work when the window vanished without a quit', () => {
    expect(decideAllWindowsClosed({ ...base, keepAlive: true })).toBe('stay')
  })

  it('on Linux closing the last window quits, even with background work and a tray icon', () => {
    expect(decideAllWindowsClosed({ ...base, platform: 'linux', keepAlive: true, trayAvailable: true })).toBe('quit')
    expect(decideAllWindowsClosed({ ...base, platform: 'linux', keepAlive: false })).toBe('quit')
  })

  it('never stays alive invisibly: without a tray icon, background work does not hold the process', () => {
    expect(decideAllWindowsClosed({ ...base, keepAlive: true, trayAvailable: false })).toBe('quit')
  })

  it('stays when renderer recovery already recreated the window', () => {
    expect(decideAllWindowsClosed({ ...base, windowRecreated: true })).toBe('stay')
    expect(decideAllWindowsClosed({ ...base, platform: 'linux', windowRecreated: true })).toBe('stay')
  })

  it('quits when nothing runs in the background', () => {
    expect(decideAllWindowsClosed(base)).toBe('quit')
  })

  it('never quits from here on macOS or in server mode', () => {
    expect(decideAllWindowsClosed({ ...base, platform: 'darwin', quitting: true })).toBe('stay')
    expect(decideAllWindowsClosed({ ...base, serverMode: true, quitting: true })).toBe('stay')
  })
})
