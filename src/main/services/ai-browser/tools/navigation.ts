/**
 * Navigation Tools (2 tools)
 *
 * Core navigation and wait.
 *
 * browser_navigate — URL navigation only. Opens the first page automatically
 *   when no active browser page exists.
 * browser_wait_for — Wait for text to appear on the page.
 *
 * Tab management (list/select/close/new) lives in tab.ts.
 * Viewport resize and history actions live in browser_evaluate as escape hatches.
 * The original standalone tools remain in their source files for future extension.
 *
 * browser_handle_dialog — Removed from registration. Native JS dialogs (alert/confirm/prompt)
 *   cannot be reliably intercepted in Electron BrowserView. Code preserved below for reference.
 */

import { z } from 'zod'
import { tool } from '../../agent/resolved-sdk'
import type { BrowserContext } from '../context'
import { browserViewManager, type DeviceMode } from '../../browser-view.service'
import { textResult, NAV_TIMEOUT } from './helpers'

export function buildNavigationTools(ctx: BrowserContext) {

const browser_navigate = tool(
  'browser_navigate',
  `Navigate to a URL. This tool only opens URLs; it does not control browser history.

Examples:
  Open a page:        { url: "https://example.com" }
  Open mobile page:   { url: "https://m.example.com", device: "h5" }

If no browser page exists, a page is created automatically. If a page is already active, it navigates that page. To keep the current page open and create another tab, use browser_tab with action: "new".

After navigation, always take a browser_snapshot to see the loaded page and get element UIDs. If the page is still loading (spinner visible, content incomplete), wait briefly (Bash: sleep 1-2) then snapshot again.

Use device: "h5" only when the target site is mobile-only or the user explicitly requests mobile view. Mobile mode opens a new page when the active page is not already in mobile mode.`,
  {
    url: z.string().describe(
      'URL to navigate to. If no browser page exists, a new page is created automatically.'
    ),
    device: z.enum(['pc', 'h5']).optional().describe(
      'Device mode. "h5" emulates mobile (iPhone UA, 390×844 viewport). Default: "pc".'
    ),
    timeout: z.number().int().optional().describe(
      'Maximum wait time in milliseconds for page load. Default: 30000. Set to 0 to use default.'
    )
  },
  async (args) => {
    const timeout = (args.timeout && args.timeout > 0) ? args.timeout : NAV_TIMEOUT
    const requestedDevice: DeviceMode = args.device ?? 'pc'
    // Only reuse a tab this caller still owns. Without the ownership check a
    // stale pointer navigates someone else's page — the failure the user saw as
    // "my page was overwritten", with nothing reported on either side.
    const rawActiveViewId = ctx.getActiveViewId()
    const activeViewId = rawActiveViewId && ctx.canReachView(rawActiveViewId) ? rawActiveViewId : null
    const activeState = activeViewId ? browserViewManager.getState(activeViewId) : undefined
    const shouldCreatePage = !activeViewId || (args.device !== undefined && activeState?.deviceMode !== requestedDevice)

    if (shouldCreatePage) {
      try {
        const viewId = `ai-browser-${Date.now()}`
        // Scoped (automation) contexts use the offscreen host window to isolate
        // view lifecycle from the user's mainWindow.
        await browserViewManager.create(viewId, args.url, {
          offscreen: ctx.isScoped,
          deviceMode: requestedDevice,
        })
        ctx.trackView(viewId)
        ctx.setActiveViewId(viewId)

        await ctx.waitForNavigation(timeout)

        const finalState = browserViewManager.getState(viewId)
        const modeLabel = requestedDevice === 'h5' ? ' [H5 mobile mode]' : ''
        return textResult(
          `Created page${modeLabel}: ${finalState?.title || 'Untitled'} - ${finalState?.url || args.url}`
        )
      } catch (error) {
        return textResult(`Failed to create page: ${(error as Error).message}`, true)
      }
    }

    try {
      await browserViewManager.navigate(activeViewId, args.url)
      await ctx.waitForNavigation(timeout)

      const finalState = browserViewManager.getState(activeViewId)
      return textResult(`Navigated to: ${finalState?.url || args.url}`)
    } catch (error) {
      return textResult(`Navigation failed: ${(error as Error).message}`, true)
    }
  }
)

const browser_wait_for = tool(
  'browser_wait_for',
  `Wait for specific text to appear on the page before proceeding. Useful after actions that trigger asynchronous loading — form submissions, AJAX updates, page transitions, single-page app route changes.

Returns success when the text is found in the page's accessibility tree, or an error on timeout. After success, take a browser_snapshot to see the updated page and get fresh UIDs.

If the text never appears (misspelled, not in the accessibility tree, loaded in an iframe), the tool times out. In that case, take a browser_snapshot anyway to see what actually loaded and adjust your approach.

Default timeout: 30 seconds.`,
  {
    text: z.string().describe('Text to wait for on the page. Must be an exact substring match against the page content.'),
    timeout: z.number().int().optional().describe(
      'Maximum wait time in milliseconds. Default: 30000. Set to 0 to use default.'
    )
  },
  async (args) => {
    const timeout = (args.timeout && args.timeout > 0) ? args.timeout : NAV_TIMEOUT

    try {
      await ctx.waitForText(args.text, timeout)
      return textResult(`Text found: "${args.text}"`)
    } catch {
      return textResult(`Timeout waiting for text: "${args.text}" (waited ${timeout}ms)`, true)
    }
  }
)

const browser_handle_dialog = tool(
  'browser_handle_dialog',
  `Handle a browser dialog (alert, confirm, prompt). Dialogs block all other page interaction until they are dismissed.

If other browser tools fail unexpectedly, a dialog may be blocking the page — call this tool to check and dismiss it.

For prompt() dialogs that require text input, provide the promptText parameter before accepting.`,
  {
    action: z.enum(['accept', 'dismiss']).describe(
      'Accept (OK/Yes) or dismiss (Cancel/No) the dialog.'
    ),
    promptText: z.string().optional().describe(
      'Text to enter into a prompt() dialog before accepting. Ignored for alert and confirm dialogs.'
    )
  },
  async (args) => {
    const dialog = ctx.getPendingDialog()
    if (!dialog) {
      return textResult('No open dialog found.', true)
    }

    try {
      await ctx.handleDialog(args.action === 'accept', args.promptText)
      return textResult(
        `Dialog ${args.action === 'accept' ? 'accepted' : 'dismissed'} successfully.`
      )
    } catch (error) {
      return textResult(`Failed to handle dialog: ${(error as Error).message}`, true)
    }
  }
)

return [
  browser_navigate,
  browser_wait_for,
]

} // end buildNavigationTools
