/**
 * The built-in browser's back and forward buttons advertise no shortcut.
 *
 * Their tooltips used to promise Alt+← / Alt+→, which nothing handles: the
 * page owns the keyboard while it has focus, and in a text field those keys
 * move the caret by a word.
 */

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/hooks/useCanvasLifecycle', () => ({
  useBrowserState: () => ({ canGoBack: true, canGoForward: true, isLoading: false, blockedByPolicy: false }),
  useCanvasActions: () => ({}),
}))
vi.mock('../../../src/renderer/components/canvas/viewer-resources', () => ({
  useViewerResources: () => ({ scope: () => ({ add: vi.fn() }) }),
}))
vi.mock('../../../src/renderer/stores/ai-browser.store', () => ({
  useAIBrowserStore: (select: (state: { operating: Record<string, boolean> }) => unknown) => select({ operating: {} }),
  selectViewOwner: () => null,
}))
vi.mock('../../../src/renderer/hooks/useSecurityPolicy', () => ({ useSecurityPolicy: () => null }))
vi.mock('../../../src/renderer/utils/browser-homepage', () => ({ getBrowserHomepage: vi.fn() }))
vi.mock('../../../src/renderer/browser-host', () => ({ bindBrowserSurface: vi.fn(), focusBrowserPage: vi.fn() }))

import { BrowserViewer } from '../../../src/renderer/components/canvas/viewers/BrowserViewer'

describe('built-in browser toolbar', () => {
  it('labels back and forward without a shortcut nothing handles', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const tab = { id: 'tab-1', type: 'browser', url: 'https://example.com', title: 'Example', browserViewId: 'view-1' }

    const html = renderToStaticMarkup(createElement(BrowserViewer, { tab } as never))

    expect(html).toContain('title="Back"')
    expect(html).toContain('title="Forward"')
    expect(html).not.toContain('Alt+')
  })
})
