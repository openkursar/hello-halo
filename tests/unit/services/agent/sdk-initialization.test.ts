import { describe, expect, it, vi } from 'vitest'

describe('engine initialization barrier', () => {
  it('holds early requests on one engine decision and releases them together', async () => {
    vi.resetModules()
    const { initializeSdkOnce, waitForSdkInitialization } = await import('../../../../src/main/services/agent/initialization')
    let resolve!: () => void
    const initialize = vi.fn(() => new Promise<void>(done => { resolve = done }))
    const first = initializeSdkOnce(initialize)
    expect(initializeSdkOnce(initialize)).toBe(first)
    let earlyRequestReady = false
    const earlyRequest = waitForSdkInitialization().then(() => { earlyRequestReady = true })
    await Promise.resolve()
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(earlyRequestReady).toBe(false)
    resolve()
    await Promise.all([first, earlyRequest])
    expect(earlyRequestReady).toBe(true)
    await waitForSdkInitialization()
  })
})
