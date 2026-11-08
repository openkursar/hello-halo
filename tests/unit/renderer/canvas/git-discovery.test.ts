import { beforeEach, describe, expect, it, vi } from 'vitest'

const discover = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/renderer/api', () => ({ api: { gitDiscoverRepository: discover } }))
import { GitDiscovery } from '../../../../src/renderer/services/git-discovery'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('opened-file repository discovery', () => {
  beforeEach(() => {
    discover.mockReset().mockResolvedValue({ success: true, data: null })
  })

  it('does no work until a file is activated and deduplicates its directory', async () => {
    const discovery = new GitDiscovery()
    expect(discover).not.toHaveBeenCalled()
    discovery.noteFile('a', '/space/sdk/src/one.ts')
    discovery.noteFile('a', '/space/sdk/src/two.ts')
    await flush()
    discovery.noteFile('a', '/space/sdk/src/three.ts')
    await flush()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(discover).toHaveBeenCalledWith('a', '/space/sdk/src/one.ts')
  })

  it('notifies only mounted consumers of the matching space after discovery completes', async () => {
    let finish!: (value: unknown) => void
    discover.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const discovery = new GitDiscovery()
    const listener = vi.fn()
    const other = vi.fn()
    const released = vi.fn()
    discovery.subscribe('a', listener)
    discovery.subscribe('b', other)
    discovery.subscribe('a', released)()
    discovery.noteFile('a', '/space/sdk/file.ts')
    await flush()
    expect(listener).not.toHaveBeenCalled()
    finish({ success: true, data: { root: '/space/sdk' } })
    await flush()
    expect(listener).toHaveBeenCalledWith({ root: '/space/sdk' })
    expect(other).not.toHaveBeenCalled()
    expect(released).not.toHaveBeenCalled()
  })

  it('isolates spaces and releases directory history', async () => {
    const discovery = new GitDiscovery()
    discovery.noteFile('a', '/space/sdk/file.ts')
    discovery.noteFile('b', '/space/sdk/file.ts')
    await flush()
    await flush()
    discovery.forget('a')
    discovery.noteFile('a', '/space/sdk/file.ts')
    discovery.noteFile('b', '/space/sdk/file.ts')
    await flush()
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it('expires directory checks without timers', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const discovery = new GitDiscovery()
      discovery.noteFile('a', '/space/file.ts')
      await flush()
      clock.mockReturnValue(62_000)
      discovery.noteFile('a', '/space/file.ts')
      await flush()
      expect(discover).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('bounds pending requests and contains transport failures', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    discover.mockImplementation(() => pending.then(() => { throw new Error('offline') }))
    try {
      const discovery = new GitDiscovery()
      for (let i = 0; i < 200; i++) discovery.noteFile('a', `/space/dir${i}/file.ts`)
      await flush()
      expect(discover).toHaveBeenCalledTimes(128)
      discovery.forget('a')
      discovery.noteFile('b', '/other/file.ts')
      await flush()
      expect(discover).toHaveBeenCalledTimes(128)
      finish()
      await flush()
      await flush()
      expect(warning).toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })
})
