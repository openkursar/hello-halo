import { beforeEach, describe, expect, it, vi } from 'vitest'

const discover = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/renderer/api', () => ({ api: { gitDiscoverRepository: discover } }))
import { GitDiscovery } from '../../../../src/renderer/services/git-discovery'
import { i18nReady, setLanguage } from '../../../../src/renderer/i18n'
import { useNotificationStore } from '../../../../src/renderer/stores/notification.store'

const repository = { root: '/space/sdk', name: 'sdk', relativePath: 'sdk' }
const recordError = { code: 'GIT_FAILED' as const, error: 'disk full' }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('opened-file repository discovery', () => {
  beforeEach(async () => {
    await i18nReady
    await setLanguage('en')
    discover.mockReset().mockResolvedValue({ success: true, data: null })
    useNotificationStore.getState().clear()
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
    finish({ success: true, data: { repository, remembered: true } })
    await flush()
    expect(listener).toHaveBeenCalledWith({ ...repository, remembered: true })
    expect(other).not.toHaveBeenCalled()
    expect(released).not.toHaveBeenCalled()
  })

  it('publishes unremembered paths and warns even when no changes view is mounted', async () => {
    const discovery = new GitDiscovery()
    discover.mockResolvedValue({ success: true, data: { repository, remembered: false, recordError } })
    const show = vi.spyOn(useNotificationStore.getState(), 'show')
    try {
      discovery.noteFile('a', '/space/sdk/one/file.ts')
      discovery.noteFile('a', '/space/sdk/two/file.ts')
      await flush()
      expect(show).toHaveBeenCalledTimes(1)
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning', body: expect.stringContaining('could not be remembered') }))
      const listener = vi.fn()
      discovery.subscribe('a', listener)
      discovery.noteFile('a', '/space/sdk/three/file.ts')
      await flush()
      expect(listener).toHaveBeenCalledWith({ ...repository, remembered: false })
      expect(show).toHaveBeenCalledTimes(1)
      discovery.noteFile('b', '/space/sdk/file.ts')
      await flush()
      expect(show).toHaveBeenCalledTimes(2)
    } finally {
      show.mockRestore()
    }
  })

  it('bounds record-failure history and releases it when a space is forgotten', () => {
    const discovery = new GitDiscovery()
    const show = vi.spyOn(useNotificationStore.getState(), 'show')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let i = 0; i < 129; i++) discovery.reportRecordFailure('a', `/space/${i}`, recordError)
      discovery.reportRecordFailure('a', '/space/128', recordError)
      expect(show).toHaveBeenCalledTimes(129)
      discovery.reportRecordFailure('a', '/space/0', recordError)
      expect(show).toHaveBeenCalledTimes(130)
      discovery.forget('a')
      discovery.reportRecordFailure('a', '/space/128', recordError)
      expect(show).toHaveBeenCalledTimes(131)
      expect(useNotificationStore.getState().toasts).toHaveLength(1)
      expect(warning).toHaveBeenCalledTimes(131)
    } finally {
      show.mockRestore()
      warning.mockRestore()
    }
  })

  it('invalidates held discoveries before they can publish or warn', async () => {
    let finish!: (value: unknown) => void
    discover.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const discovery = new GitDiscovery()
    const listener = vi.fn()
    discovery.subscribe('a', listener)
    discovery.noteFile('a', '/space/sdk/file.ts')
    await flush()
    discovery.forget('a')
    finish({ success: true, data: { repository, remembered: false, recordError } })
    await flush()
    expect(listener).not.toHaveBeenCalled()
    expect(useNotificationStore.getState().toasts).toEqual([])
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
