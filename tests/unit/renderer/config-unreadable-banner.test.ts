/**
 * When the config file cannot be read, the app says so — where the file is and
 * that saving is paused — and a settings write that came back unsaved is
 * reported instead of being shown as saved.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/components/layout/Header', () => ({
  usePlatform: () => ({ isMac: false, isLinux: false, isWindows: true }),
}))

import { ConfigUnreadableNotice } from '../../../src/renderer/components/settings/ConfigUnreadableBanner'
import { CONFIG_NOT_SAVED_EVENT, configApi, reportIfNotSaved } from '../../../src/renderer/api/config.api'

const NOT_SAVED = { success: false, code: 'CONFIG_UNREADABLE', error: 'Not saved' }

/** A window that counts not-saved events, optionally with an Electron bridge. */
function stubWindow(halo?: Record<string, unknown>): () => number {
  const target = new EventTarget()
  if (halo) Object.assign(target, { halo })
  let seen = 0
  target.addEventListener(CONFIG_NOT_SAVED_EVENT, () => { seen++ })
  vi.stubGlobal('window', target)
  return () => seen
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
    expect(html).toContain('role="alert"')
  })
})

describe('writes that came back unsaved', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('are announced once each, and other failures are not', () => {
    const seen = stubWindow()

    expect(reportIfNotSaved(NOT_SAVED)).toBe(NOT_SAVED)
    reportIfNotSaved({ success: false, error: 'network down' })
    reportIfNotSaved({ success: true })

    expect(seen()).toBe(1)
  })

  it('are announced from the settings save itself, whatever the caller does with the result', async () => {
    const seen = stubWindow({ setConfig: vi.fn(async () => NOT_SAVED) })

    await configApi.setConfig({ appearance: { theme: 'dark' } })

    expect(seen()).toBe(1)
  })
})
