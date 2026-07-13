/**
 * Tests for canvas-context formatting.
 *
 * The <halo_canvas> block is the AI's only awareness of what the user is
 * currently viewing. For terminal tabs it must expose the pty session id so the
 * AI can map "the terminal I'm looking at" to a concrete terminal_* handle
 * (otherwise it can see the tab title but cannot drive it).
 */

import { describe, it, expect } from 'vitest'
import { formatCanvasContext } from '../../../../src/main/services/agent/message-utils'
import type { CanvasContext } from '../../../../src/main/services/agent/types'

describe('formatCanvasContext', () => {
  it('returns empty string when the canvas is closed or has no tabs', () => {
    expect(formatCanvasContext(undefined)).toBe('')
    expect(formatCanvasContext({ isOpen: false, tabCount: 0, activeTab: null, tabs: [] })).toBe('')
    expect(formatCanvasContext({ isOpen: true, tabCount: 0, activeTab: null, tabs: [] })).toBe('')
  })

  it('exposes the terminal session id for terminal tabs so the AI can drive them', () => {
    const ctx: CanvasContext = {
      isOpen: true,
      tabCount: 1,
      activeTab: { type: 'terminal', title: 'Terminal', terminalSessionId: 'term_1_abc' },
      tabs: [{ type: 'terminal', title: 'Terminal', terminalSessionId: 'term_1_abc', isActive: true }]
    }
    const out = formatCanvasContext(ctx)
    // Active-tab section names the session id and points at the tools.
    expect(out).toContain('Terminal session id: term_1_abc')
    // The per-tab summary line also carries it.
    expect(out).toContain('▶ Terminal (terminal) - session: term_1_abc')
  })

  it('keeps browser url / file path rendering intact and omits session for non-terminal tabs', () => {
    const ctx: CanvasContext = {
      isOpen: true,
      tabCount: 2,
      activeTab: { type: 'browser', title: 'Bing', url: 'https://www.bing.com/' },
      tabs: [
        { type: 'browser', title: 'Bing', url: 'https://www.bing.com/', isActive: true },
        { type: 'code', title: 'index.ts', path: '/src/index.ts', isActive: false }
      ]
    }
    const out = formatCanvasContext(ctx)
    expect(out).toContain('- URL: https://www.bing.com/')
    expect(out).toContain('index.ts (code) - /src/index.ts')
    expect(out).not.toContain('session:')
  })
})
