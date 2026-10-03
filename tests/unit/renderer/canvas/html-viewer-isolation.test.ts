/**
 * Which frame an HTML tab previews in: a desktop file gets its own preview
 * origin (asked of the main process after mount), content without a file — or
 * any remote client — gets an opaque-origin srcdoc. Neither ever shares the
 * app origin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let remote = false
vi.mock('../../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../../src/renderer/api', () => ({
  api: {
    isRemoteMode: () => remote,
    openHtmlPreview: vi.fn(),
    closeHtmlPreview: vi.fn(),
  },
}))
vi.mock('../../../../src/renderer/hooks/useCanvasLifecycle', () => ({
  useCanvasActions: () => ({ openUrl: vi.fn(), closeTab: vi.fn() }),
}))

const { HtmlViewer } = await import('../../../../src/renderer/components/canvas/viewers/HtmlViewer')

const tab = (path?: string) => ({
  id: 't', type: 'html' as const, title: 'page', path, content: '<p>x</p>', isDirty: false, isLoading: false, view: {},
})
const render = (path?: string) => renderToStaticMarkup(createElement(HtmlViewer, { tab: tab(path) }))

beforeEach(() => { remote = false })

describe('HtmlViewer', () => {
  it('waits for the preview origin for a desktop file instead of rendering it in srcdoc', () => {
    const html = render('/w/site/index.html')
    expect(html).not.toContain('<iframe')
  })

  it('previews generated content (no file) in an opaque-origin srcdoc', () => {
    const html = render(undefined)
    expect(html).toContain('srcDoc=')
    expect(html).toMatch(/sandbox="allow-scripts allow-forms allow-popups"/)
  })

  it('previews in srcdoc on a remote client, without a local base', () => {
    remote = true
    const html = render('/w/site/index.html')
    expect(html).toContain('srcDoc=')
    expect(html).not.toContain('halo-file:')
    expect(html).not.toContain('allow-same-origin')
  })
})
