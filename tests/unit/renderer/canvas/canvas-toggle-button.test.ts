/**
 * The canvas can be collapsed from its tab bar without closing anything, and a
 * collapsed canvas is brought back from a handle on the edge of the page that
 * shows how many tabs are waiting. Neither shows when there are no tabs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const canvas = vi.hoisted(() => ({ isOpen: true, tabCount: 0, toggleOpen: () => {}, reorderTabs: () => {} }))
vi.mock('../../../../src/renderer/hooks/useCanvasLifecycle', () => ({
  useCanvasIsOpen: () => canvas.isOpen,
  useTabCount: () => canvas.tabCount,
  useCanvasActions: () => ({ toggleOpen: canvas.toggleOpen, reorderTabs: canvas.reorderTabs }),
  useTabList: () => [],
  useActiveTabId: () => null,
}))
vi.mock('../../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../../src/renderer/stores/canvas.store', () => ({ useCanvasStore: () => false }))
vi.mock('../../../../src/renderer/components/canvas/viewers/useWindowMaximize', () => ({
  useWindowMaximize: () => ({ isMaximized: false, toggleMaximize: async () => {} }),
}))
vi.mock('../../../../src/renderer/utils/browser-homepage', () => ({ getBrowserHomepage: async () => 'about:blank' }))
vi.mock('../../../../src/renderer/services/tool-session-telemetry', () => ({ trackToolOpen: () => {} }))

const { CanvasToggleButton } = await import('../../../../src/renderer/components/canvas/CanvasToggleButton')
const { CanvasTabs } = await import('../../../../src/renderer/components/canvas/CanvasTabs')

const render = (placement: 'tab-bar' | 'edge') => renderToStaticMarkup(createElement(CanvasToggleButton, { placement }))

beforeEach(() => {
  canvas.isOpen = true
  canvas.tabCount = 0
  canvas.toggleOpen = vi.fn()
})

describe('collapsing and restoring the canvas', () => {
  it('offers collapse in the tab bar while open, without a count', () => {
    canvas.tabCount = 2
    const markup = render('tab-bar')
    expect(markup).toMatch(/^<button class="canvas-tab-bar-action" title="Collapse canvas" aria-label="Collapse canvas">/)
    expect(markup).not.toContain('<span>')
    expect(render('edge')).toBe('')
  })

  it('offers the way back on the page edge while collapsed, with the number of tabs', () => {
    canvas.tabCount = 3
    canvas.isOpen = false
    const markup = render('edge')
    expect(markup).toContain('title="Expand canvas" aria-label="Expand canvas"')
    expect(markup).toContain('<span>3</span>')
    expect(render('tab-bar')).toBe('')
  })

  it('shows neither when there are no tabs', () => {
    expect(render('tab-bar')).toBe('')
    canvas.isOpen = false
    expect(render('edge')).toBe('')
  })

  it('toggles the canvas, which keeps its tabs', () => {
    canvas.tabCount = 1
    const button = CanvasToggleButton({ placement: 'tab-bar' }) as ReactElement<{ onClick: () => void }>
    button.props.onClick()
    expect(canvas.toggleOpen).toHaveBeenCalledTimes(1)
  })

  it('places the collapse control in the tab bar right before "close all"', () => {
    const tab = { id: 'tab-1', type: 'browser', title: 'Docs', path: undefined, isLoading: false, isDirty: false, error: undefined }
    const markup = renderToStaticMarkup(createElement(CanvasTabs, {
      tabs: [tab] as never,
      activeTabId: 'tab-1',
      onTabClick: () => {},
      onTabClose: () => {},
      onCloseAll: () => {},
      collapseControl: createElement('i', { id: 'collapse' }),
    }))
    const actions = markup.slice(markup.indexOf('canvas-tab-bar-actions'))
    expect(actions.indexOf('<i id="collapse"></i>')).toBeGreaterThan(-1)
    expect(actions.indexOf('<i id="collapse"></i>')).toBeLessThan(actions.indexOf('title="Close all tabs"'))
  })
})
