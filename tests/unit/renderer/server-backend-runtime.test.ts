import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  runtime: vi.fn(), content: vi.fn(), download: vi.fn(),
  setState: vi.fn(), value: null as unknown, deps: undefined as unknown[] | undefined,
  cleanup: undefined as (() => void) | undefined,
  connected: undefined as ((state: string) => void) | undefined,
}))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [host.value ?? initial, host.setState],
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useEffect: (effect: () => () => void, deps: unknown[]) => {
    if (!host.deps || deps.some((value, i) => host.deps![i] !== value)) {
      host.cleanup?.(); host.cleanup = effect(); host.deps = deps
    }
  },
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: {}, useTranslation: () => ({ t: (s: string) => s }) }))
vi.mock('../../../src/renderer/api', () => ({ api: {
  getRuntimeInfo: host.runtime, readArtifactContent: host.content, downloadArtifact: host.download, isRemoteMode: () => true,
} }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }))
vi.mock('../../../src/renderer/api/transport', async original => ({
  ...await original<typeof import('../../../src/renderer/api/transport')>(),
  onWsStateChange: (callback: (state: string) => void) => { host.connected = callback; return () => { host.connected = undefined } },
}))
import { setActiveServerUrl, setServerUrl, clearPendingServerUrl, onServerUrlChange } from '../../../src/renderer/api/transport'
import { useBackendRuntime } from '../../../src/renderer/hooks/useServerBackend'
import { useDataContent } from '../../../src/renderer/hooks/useDataContent'
import { DataPathPanel } from '../../../src/renderer/components/apps/DataPathPanel'

const flush = () => new Promise(resolve => setImmediate(resolve))
const success = (serverMode: boolean) => ({ success: true, data: { serverMode } })

beforeEach(() => {
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
  host.value = null; host.deps = undefined; host.cleanup = undefined
  host.setState.mockImplementation(value => { host.value = value })
  setActiveServerUrl('https://a.test')
})
afterEach(() => { host.cleanup?.(); clearPendingServerUrl(); vi.resetAllMocks(); vi.unstubAllGlobals() })

describe('backend capability discovery', () => {
  it('never probes a local desktop or a disabled consumer', () => {
    expect(useBackendRuntime(false)).toBeNull()
    vi.stubGlobal('window', { halo: {} })
    expect(useBackendRuntime()).toEqual({ serverMode: false })
    expect(host.runtime).not.toHaveBeenCalled()
  })
  it('revokes the previous answer immediately on a switch and ignores its late reply', async () => {
    host.runtime.mockResolvedValueOnce(success(true))
    expect(useBackendRuntime()).toBeNull()
    await flush()
    expect(useBackendRuntime()).toEqual({ serverMode: true })
    let finish!: (value: unknown) => void
    host.runtime.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    host.connected?.('connected')
    setActiveServerUrl('https://b.test')
    host.runtime.mockResolvedValueOnce(success(false))
    expect(useBackendRuntime()).toBeNull()
    await flush()
    finish(success(true)); await flush()
    expect(useBackendRuntime()).toEqual({ serverMode: false })
  })
  it('retries a transient error on reconnect', async () => {
    host.runtime.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(success(true))
    expect(useBackendRuntime()).toBeNull(); await flush()
    expect(useBackendRuntime()).toBeNull()
    host.connected?.('connected'); await flush()
    expect(useBackendRuntime()).toEqual({ serverMode: true })
  })
  it('notifies only when the effective connection changes', () => {
    const changed = vi.fn(); const stop = onServerUrlChange(changed)
    try {
      setServerUrl('https://a.test/'); setServerUrl('https://b.test/')
      setActiveServerUrl('https://b.test'); clearPendingServerUrl()
      expect(changed).toHaveBeenCalledTimes(1)
      setActiveServerUrl(null)
      expect(changed).toHaveBeenCalledTimes(2)
    } finally { stop() }
  })
})

describe('report detail', () => {
  it('distinguishes empty text from a failed preview and discards the previous path', async () => {
    host.content.mockResolvedValueOnce({ success: true, data: { content: '' } }).mockResolvedValueOnce({ success: false, error: 'Unavailable' })
    const preview = (dataPath: string, data?: string) => useDataContent({ summary: 'Report', dataPath, data })
    preview('empty.md'); await flush()
    expect(preview('empty.md')).toEqual({ text: '', unreadable: false })
    expect(preview('missing.md')).toEqual({ text: undefined, unreadable: false }); await flush()
    expect(preview('missing.md')).toEqual({ text: undefined, unreadable: true })
    expect(preview('missing.md', 'inline')).toEqual({ text: 'inline', unreadable: false })
  })
  it('shows a download failure returned as an ordinary API result on the clicked report', async () => {
    host.download.mockResolvedValue({ success: false, error: 'Unavailable' })
    const render = (dataPath: string) => DataPathPanel({ dataPath }).props.children
    await render('plan.md')[0].props.onClick()
    expect(render('plan.md')[1].props.role).toBe('alert')
    expect(render('other.md')[1]).toBe(false)
    host.download.mockResolvedValue({ success: true })
    await render('plan.md')[0].props.onClick()
    expect(render('plan.md')[1]).toBe(false)
  })
})
