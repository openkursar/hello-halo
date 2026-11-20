/**
 * The canvas can be collapsed from its tab bar without closing anything, and a
 * collapsed canvas is brought back from a handle on the edge of the page that
 * shows how many tabs are waiting. Neither shows when there are no tabs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const canvas = vi.hoisted(() => ({
  isOpen: true, tabCount: 0, toggleOpen: () => {}, reorderTabs: () => {}, closeTabs: () => {},
  aiOperating: false, operatingTabs: new Set<string>(), canEnd: true,
}))
vi.mock('../../../../src/renderer/hooks/useCanvasLifecycle', () => ({
  useCanvasIsOpen: () => canvas.isOpen,
  useTabCount: () => canvas.tabCount,
  useCanvasActions: () => ({ toggleOpen: canvas.toggleOpen, reorderTabs: canvas.reorderTabs, closeTabs: canvas.closeTabs }),
  useTabList: () => [],
  useActiveTabId: () => null,
}))
vi.mock('../../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../../src/renderer/stores/canvas.store', () => ({ useCanvasStore: () => false }))
vi.mock('../../../../src/renderer/components/canvas/viewers/useWindowMaximize', () => ({
  useWindowMaximize: () => ({ isMaximized: false, toggleMaximize: async () => {} }),
}))
vi.mock('../../../../src/renderer/hooks/useAIWork', () => ({
  useSpaceAIOperating: () => canvas.aiOperating,
  useAIWorkOperating: (tab: { id: string }) => canvas.operatingTabs.has(tab.id),
  useAIWorkOwnerLabel: () => null,
}))
vi.mock('../../../../src/renderer/services/ai-work-tabs', () => ({ canEndOnThisClient: () => canvas.canEnd }))
vi.mock('../../../../src/renderer/utils/browser-homepage', () => ({ getBrowserHomepage: async () => 'about:blank' }))
vi.mock('../../../../src/renderer/services/tool-session-telemetry', () => ({ trackToolOpen: () => {} }))

const { CanvasToggleButton } = await import('../../../../src/renderer/components/canvas/CanvasToggleButton')
const { CanvasTabs } = await import('../../../../src/renderer/components/canvas/CanvasTabs')

const render = (placement: 'tab-bar' | 'edge' | 'header') => renderToStaticMarkup(createElement(CanvasToggleButton, { placement }))

beforeEach(() => {
  canvas.isOpen = true
  canvas.tabCount = 0
  canvas.toggleOpen = vi.fn()
  canvas.aiOperating = false
  canvas.operatingTabs = new Set()
  canvas.canEnd = true
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

  it('places the collapse control last in the tab bar, after "close canvas"', () => {
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
    const closeCanvas = actions.indexOf('title="Close canvas (clears all tabs)"')
    expect(closeCanvas).toBeGreaterThan(-1)
    expect(actions.indexOf('<i id="collapse"></i>')).toBeGreaterThan(closeCanvas)
  })

  it('counts every tab, the AI\'s included, and adds a dot only while the AI is operating one', () => {
    canvas.tabCount = 5
    canvas.isOpen = false
    expect(render('edge')).toContain('<span>5</span>')
    expect(render('edge')).not.toContain('AI is operating')

    canvas.aiOperating = true
    const markup = render('edge')
    expect(markup).toContain('<span>5</span>')
    expect(markup).toContain('role="img" aria-label="AI is operating"')
    // It pulses only for people who have not asked the system to reduce motion.
    expect(markup).toContain('motion-safe:animate-pulse')
  })

  it('offers the same way back among a phone\'s header buttons, never over the conversation', () => {
    canvas.tabCount = 2
    canvas.isOpen = false
    canvas.aiOperating = true
    const markup = render('header')
    expect(markup).toContain('title="Expand canvas" aria-label="Expand canvas"')
    expect(markup).toContain('<span>2</span>')
    expect(markup).toContain('aria-label="AI is operating"')
    expect(markup).not.toContain('absolute')
    canvas.isOpen = true
    expect(render('header')).toBe('')
  })

  it('shows no operating dot while the canvas is open: the tabs say it themselves', () => {
    canvas.tabCount = 2
    canvas.aiOperating = true
    expect(render('tab-bar')).not.toContain('AI is operating')
  })
})

describe('the AI\'s tabs in the tab bar', () => {
  const aiTab = { id: 'ai-1', type: 'terminal', title: 'npm run dev', path: undefined, isLoading: false, isDirty: false, error: undefined, aiWork: true, terminalSessionId: 's1' }
  const ownTab = { id: 'own-1', type: 'browser', title: 'Docs', path: undefined, isLoading: false, isDirty: false, error: undefined }
  const bar = (tabs: unknown[]) => renderToStaticMarkup(createElement(CanvasTabs, {
    tabs: tabs as never, activeTabId: 'own-1', onTabClick: () => {}, onTabClose: () => {},
  }))

  it('marks only the AI\'s tabs, with a dot that is still while the AI is idle', () => {
    const markup = bar([ownTab, aiTab])
    expect(markup.match(/canvas-tab-ai-dot/g)).toHaveLength(1)
    expect(markup).toContain('data-ai-operating="false"')
    expect(markup).not.toContain('motion-safe:animate-pulse')
  })

  it('pulses the dot of the tab the AI is operating', () => {
    canvas.operatingTabs = new Set(['ai-1'])
    const markup = bar([ownTab, aiTab])
    expect(markup).toContain('data-ai-operating="true"')
    expect(markup).toContain('motion-safe:animate-pulse')
  })

  it('keeps the tab title free of any prefix', () => {
    expect(bar([aiTab])).toContain('>npm run dev</span>')
  })

  it('says "close canvas" keeps the AI\'s tabs when they are beside the user\'s own', () => {
    const tabBar = (tabs: unknown[]) => renderToStaticMarkup(createElement(CanvasTabs, {
      tabs: tabs as never, activeTabId: 'own-1', onTabClick: () => {}, onTabClose: () => {}, onCloseAll: () => {},
    }))
    expect(tabBar([ownTab, aiTab])).toContain('title="Close canvas (keeps tabs the AI is using)"')
    expect(tabBar([ownTab])).toContain('title="Close canvas (clears all tabs)"')
    // With only the AI's tabs left, closing asks before it ends them and then clears everything.
    expect(tabBar([aiTab])).toContain('title="Close canvas (clears all tabs)"')
  })

  it('has no close on a client that cannot end what the tab runs, and says why', () => {
    canvas.canEnd = false
    const markup = bar([aiTab])
    expect(markup).not.toContain('<button')
    expect(markup).toContain('Can only be closed on the computer')
  })
})
