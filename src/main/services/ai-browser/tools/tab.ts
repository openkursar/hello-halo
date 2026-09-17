/**
 * Tab Management Tool (1 tool)
 *
 * Manage browser tabs: list, open, switch, close.
 * Consolidates browser_list_pages, browser_new_page, browser_select_page, and
 * browser_close_page into a single intent-level tool.
 *
 * Browser history actions are intentionally not exposed here. They depend on
 * invisible history state and are better handled by browser_evaluate when needed.
 */

import { z } from 'zod'
import { tool } from '../../agent/resolved-sdk'
import type { BrowserContext } from '../context'
import { browserViewManager, type DeviceMode } from '../../browser-view.service'
import { textResult, NAV_TIMEOUT } from './helpers'

const log = (...args: unknown[]) => console.log('[AI Browser][tab]', ...args)

export function buildTabTools(ctx: BrowserContext) {

const browser_tab = tool(
  'browser_tab',
  `Manage browser tabs: list all open tabs, open a new tab, switch between tabs, or close a tab.

Examples:
  List all tabs:              { action: "list" }
  Open a new tab:             { action: "new", url: "https://example.com" }
  Open a mobile new tab:      { action: "new", url: "https://m.example.com", device: "h5" }
  Switch to tab at index 2:   { action: "select", pageIdx: 2 }
  Close tab at index 1:       { action: "close", pageIdx: 1 }

Use browser_navigate for normal page opening. Use action: "new" only when you need to keep the current page open. After "new" or "select", take a browser_snapshot to see the active tab's content and get fresh UIDs. Tab indices may shift after closing a tab — use "list" to get current indices.

The last remaining tab cannot be closed.`,
  {
    action: z.enum(['list', 'new', 'select', 'close']).describe(
      'Tab management action: "list" shows tabs, "new" opens a new tab, "select" switches tabs, "close" closes a tab.'
    ),
    url: z.string().optional().describe(
      'URL to open. Required for action: "new".'
    ),
    device: z.enum(['pc', 'h5']).optional().describe(
      'Device mode for action: "new". "h5" emulates mobile (iPhone UA, 390×844 viewport). Default: "pc".'
    ),
    pageIdx: z.number().optional().describe(
      'Tab index — required for "select" and "close". Get indices from action: "list".'
    ),
    timeout: z.number().int().optional().describe(
      'Maximum wait time in milliseconds for action: "new" page load. Default: 30000. Set to 0 to use default.'
    )
  },
  async (args) => {
    // The tabs THIS caller owns, never every tab in the app. Enumerating the
    // manager directly let one agent list, select and navigate another's pages
    // (and the user's), which is how a page being worked on got overwritten
    // with no signal to the side that lost it.
    const states = ctx.visibleViewStates()

    switch (args.action) {
      case 'list': {
        if (states.length === 0) {
          return textResult('No browser pages are currently open.')
        }
        const lines = ['Open browser pages:']
        states.forEach((state, index) => {
          lines.push(`[${index}] ${state.title || 'Untitled'} - ${state.url || 'about:blank'}`)
        })
        return textResult(lines.join('\n'))
      }

      case 'new': {
        if (!args.url) {
          return textResult('url is required for action "new".', true)
        }

        const timeout = (args.timeout && args.timeout > 0) ? args.timeout : NAV_TIMEOUT
        const deviceMode: DeviceMode = args.device ?? 'pc'

        try {
          const viewId = `ai-browser-${Date.now()}`
          await browserViewManager.create(viewId, args.url, {
            offscreen: ctx.isScoped,
            deviceMode,
          })
          ctx.trackView(viewId)
          ctx.setActiveViewId(viewId)
          await ctx.waitForNavigation(timeout)

          const finalState = browserViewManager.getState(viewId)
          const modeLabel = deviceMode === 'h5' ? ' [H5 mobile mode]' : ''
          log(`new page: ${viewId}, deviceMode=${deviceMode}`)
          return textResult(
            `Created page${modeLabel}: ${finalState?.title || 'Untitled'} - ${finalState?.url || args.url}`
          )
        } catch (error) {
          return textResult(`Failed to create page: ${(error as Error).message}`, true)
        }
      }

      case 'select': {
        if (args.pageIdx === undefined) {
          return textResult('pageIdx is required for action "select".', true)
        }
        if (args.pageIdx < 0 || args.pageIdx >= states.length) {
          return textResult(
            `Invalid page index: ${args.pageIdx}. Valid range: 0-${states.length - 1}`,
            true
          )
        }
        const state = states[args.pageIdx]
        ctx.setActiveViewId(state.id)
        log(`select page [${args.pageIdx}]: ${state.id}`)
        return textResult(
          `Selected page [${args.pageIdx}]: ${state.title || 'Untitled'} - ${state.url}`
        )
      }

      case 'close': {
        if (args.pageIdx === undefined) {
          return textResult('pageIdx is required for action "close".', true)
        }
        if (args.pageIdx < 0 || args.pageIdx >= states.length) {
          return textResult(`Invalid page index: ${args.pageIdx}`, true)
        }
        if (states.length === 1) {
          return textResult('The last open page cannot be closed.', true)
        }
        const closedState = states[args.pageIdx]
        const wasActive = ctx.getActiveViewId() === closedState.id
        browserViewManager.destroy(closedState.id)
        log(`close page [${args.pageIdx}]: ${closedState.id}, wasActive=${wasActive}`)

        if (wasActive) {
          const remaining = ctx.visibleViewStates()
          if (remaining.length > 0) {
            const newIdx = Math.min(args.pageIdx, remaining.length - 1)
            ctx.setActiveViewId(remaining[newIdx].id)
            log(`auto-switched to page [${newIdx}]: ${remaining[newIdx].id}`)
          }
        }

        return textResult(`Closed page [${args.pageIdx}]: ${closedState.title || 'Untitled'}`)
      }
    }
  }
)

return [browser_tab]

} // end buildTabTools
