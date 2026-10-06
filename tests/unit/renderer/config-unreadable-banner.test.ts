/**
 * When the config file cannot be read, the app says so — where the file is and
 * that saving is paused — and a settings write that came back unsaved is
 * reported instead of being shown as saved.
 *
 * Once the file reads again, the app's settings are reloaded: until then they
 * are the defaults Halo fell back to, and a save built on them would replace
 * what the file holds. Every save carries the stamp of the settings it was
 * built on, so main can refuse one built on settings from before a failure.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { httpRequest, translate } = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  translate: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')),
}))

vi.mock('../../../src/renderer/i18n', () => ({
  default: { t: translate },
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/api/transport', () => ({
  isElectron: () => typeof window !== 'undefined' && 'halo' in window,
  isCapacitor: () => false,
  httpRequest,
}))
vi.mock('../../../src/renderer/stores/app.store', () => ({
  useAppStore: { getState: () => ({ refreshConfig: vi.fn() }) },
}))
vi.mock('../../../src/renderer/components/layout/Header', () => ({
  usePlatform: () => ({ isMac: false, isLinux: false, isWindows: true }),
}))

import { ConfigUnreadableNotice, createReadFailureWatch } from '../../../src/renderer/components/settings/ConfigUnreadableBanner'
import { CONFIG_NOT_SAVED_EVENT, configApi, reportIfNotSaved } from '../../../src/renderer/api/config.api'

const NOT_SAVED = { success: false, code: 'CONFIG_UNREADABLE', error: 'Not saved' }
const RELOAD_REQUIRED = { success: false, code: 'CONFIG_RELOAD_REQUIRED', error: 'Not saved' }

/** A window that records the codes of not-saved events, optionally with an Electron bridge. */
function stubWindow(halo?: Record<string, unknown>): string[] {
  const target = new EventTarget()
  if (halo) Object.assign(target, { halo })
  const codes: string[] = []
  target.addEventListener(CONFIG_NOT_SAVED_EVENT, (event) => {
    codes.push((event as CustomEvent<{ code: string }>).detail.code)
  })
  vi.stubGlobal('window', target)
  return codes
}

describe('config unreadable notice', () => {
  it('says saving is paused and shows where the file is', () => {
    const html = renderToStaticMarkup(createElement(ConfigUnreadableNotice, {
      path: 'C:\\Users\\u\\.halo\\config.json',
      topOffset: 0,
      onCheckAgain: () => undefined,
      onHide: () => undefined,
    }))

    expect(html).toContain('The configuration file cannot be read. Halo has paused saving settings to protect your data.')
    expect(html).toContain('C:\\Users\\u\\.halo\\config.json')
    expect(html).toContain('Check again')
    expect(html).toContain('aria-label="Hide for now"')
    expect(html).toContain('role="alert"')
  })
})

describe('writes that came back unsaved', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('are announced once each, saying why, and other failures are not', () => {
    const codes = stubWindow()

    expect(reportIfNotSaved(NOT_SAVED)).toBe(NOT_SAVED)
    reportIfNotSaved(RELOAD_REQUIRED)
    reportIfNotSaved({ success: false, error: 'network down' })
    reportIfNotSaved({ success: true })

    expect(codes).toEqual(['CONFIG_UNREADABLE', 'CONFIG_RELOAD_REQUIRED'])
  })

  it('are announced from the settings save itself, whatever the caller does with the result', async () => {
    const codes = stubWindow({ setConfig: vi.fn(async () => NOT_SAVED) })

    await configApi.setConfig({ appearance: { theme: 'dark' } })

    expect(codes).toEqual(['CONFIG_UNREADABLE'])
  })
})

describe('the stamp a settings save carries', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    httpRequest.mockReset()
  })

  it('is the one of the settings the app keeps, not of any other read', async () => {
    const setConfig = vi.fn(async () => ({ success: true }))
    const getConfig = vi.fn()
      .mockResolvedValueOnce({ success: true, data: {}, configEpoch: 4 })
      .mockResolvedValueOnce({ success: true, data: {}, configEpoch: 9 })
    stubWindow({ getConfig, setConfig })

    await configApi.getConfig({ snapshot: true })
    // A view reading the config for itself does not replace the app's settings.
    await configApi.getConfig()
    await configApi.setConfig({ imChannels: { instances: [] } })

    expect(setConfig).toHaveBeenCalledWith({ imChannels: { instances: [] } }, 4)
  })

  it('travels as a query parameter over HTTP', async () => {
    stubWindow()
    httpRequest
      .mockResolvedValueOnce({ success: true, data: {}, configEpoch: -1 })
      .mockResolvedValueOnce({ success: true })

    await configApi.getConfig({ snapshot: true })
    await configApi.setConfig({ imChannels: { instances: [] } })

    expect(httpRequest).toHaveBeenLastCalledWith('POST', '/api/config?snapshotEpoch=-1', { imChannels: { instances: [] } })
  })
})

describe('watching the config file', () => {
  function watchWith(responses: Array<{ success: boolean; data?: { path: string } | null }>) {
    const fetchFailure = vi.fn()
    for (const response of responses) fetchFailure.mockResolvedValueOnce(response)
    const deps = { fetchFailure, showPath: vi.fn(), reloadSettings: vi.fn(), onRecovered: vi.fn() }
    return { watch: createReadFailureWatch(deps), deps }
  }

  const UNREADABLE = { success: true, data: { path: '/home/u/.halo/config.json' } }
  const READABLE = { success: true, data: null }

  it('reloads the app’s settings the moment the file reads again', async () => {
    const { watch, deps } = watchWith([UNREADABLE, READABLE, READABLE])

    await watch.check()
    expect(deps.reloadSettings).not.toHaveBeenCalled()

    await watch.check()
    await watch.check()

    expect(deps.showPath.mock.calls.map(([path]) => path)).toEqual(['/home/u/.halo/config.json', null, null])
    expect(deps.reloadSettings).toHaveBeenCalledTimes(1)
    expect(deps.onRecovered).toHaveBeenCalledTimes(1)
  })

  it('leaves the settings alone when the file was readable all along', async () => {
    const { watch, deps } = watchWith([READABLE, READABLE])

    await watch.check()
    await watch.check()

    expect(deps.reloadSettings).not.toHaveBeenCalled()
  })

  it('reloads once when main refuses a save built on old settings', async () => {
    const { watch, deps } = watchWith([UNREADABLE, READABLE])

    await watch.check()
    watch.reloadRequired()
    await watch.check()

    expect(deps.showPath).toHaveBeenLastCalledWith(null)
    expect(deps.reloadSettings).toHaveBeenCalledTimes(1)
    expect(deps.onRecovered).not.toHaveBeenCalled()
  })

  it('changes nothing when the check itself fails', async () => {
    const { watch, deps } = watchWith([{ success: false }])

    await watch.check()

    expect(deps.showPath).not.toHaveBeenCalled()
    expect(deps.reloadSettings).not.toHaveBeenCalled()
  })
})
