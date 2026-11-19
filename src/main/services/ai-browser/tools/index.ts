/**
 * AI Browser Tools — Aggregation layer
 *
 * Imports all active tool category builders and exports a single
 * buildAllTools() function that returns all 14 SDK tools.
 *
 * Tool inventory (28 → 14):
 *   Navigation:  browser_navigate, browser_wait_for                         (2)
 *   Input:       browser_click, browser_fill, browser_hover,
 *                browser_press_key, browser_upload_file                     (5)
 *   Snapshot:    browser_snapshot, browser_screenshot, browser_evaluate      (3)
 *   Script:      browser_run                                                (1)
 *   Tab:         browser_tab                                                (1)
 *   Inspect:     browser_inspect                                            (1)
 *   Download:    browser_download                                           (1)
 *
 * Retired from default registration (code preserved for future extension):
 *   - navigation.ts (browser_handle_dialog) — Electron cannot intercept native JS dialogs
 *   - emulation.ts  (browser_emulate)
 *   - performance.ts (browser_perf_start, browser_perf_stop, browser_perf_insight)
 *   - network.ts    (browser_network_requests, browser_network_request)
 *   - console.ts    (browser_console, browser_console_message)
 */

import type { BrowserContext } from '../context'
import type { SdkMcpToolDefinition } from '../../agent/mcp/types'
import { isServerMode } from '../../../foundation/runtime-mode'
import { buildNavigationTools } from './navigation'
import { buildInputTools } from './input'
import { textResult } from './helpers'
import { buildSnapshotTools } from './snapshot'
import { buildScriptTools } from './script'
import { buildTabTools } from './tab'
import { buildInspectTools } from './inspect'
import { buildDownloadTools } from './download'

/**
 * Build all 14 AI Browser tools, closing over the provided BrowserContext.
 * This allows each MCP server instance to operate on its own context
 * (scoped activeViewId) while sharing the same browserViewManager session.
 */
export function buildAllTools(ctx: BrowserContext) {
  const tools = [
    ...buildNavigationTools(ctx),  // 2 tools: navigate, wait_for
    ...buildInputTools(ctx),       // 5 tools: click, fill, hover, press_key, upload_file (+ fill_secret on a server)
    ...buildSnapshotTools(ctx),    // 3 tools: snapshot, screenshot, evaluate
    ...buildScriptTools(ctx),      // 1 tool:  run
    ...buildTabTools(ctx),         // 1 tool:  tab
    ...buildInspectTools(ctx),     // 1 tool:  inspect
    ...buildDownloadTools(ctx),    // 1 tool:  download
  ]
  // Only a remote live view (server mode) lets a person operate a page from
  // outside its window, so only there can a tool result need the notice.
  const inputAware = isServerMode() ? tools.map(definition => withUserInputNotice(ctx, definition)) : tools
  return inputAware.map(definition => operating(ctx, definition))
}

interface ToolDefinition {
  name: string
  handler: (args: unknown, extra: unknown) => Promise<{ content?: unknown[] } | undefined>
}

/** Do not run an action chosen before the person touched the page. */
function withUserInputNotice<T extends ToolDefinition>(ctx: BrowserContext, definition: T): T {
  return {
    ...definition,
    handler: async (args: unknown, extra: unknown) => {
      const notice = ctx.takeUserInputNotice()
      if (notice && definition.name !== 'browser_snapshot') return textResult(notice, true)
      const result = await definition.handler(args, extra)
      if (!notice || !result) return result
      return { ...result, content: [...(result.content ?? []), { type: 'text', text: notice }] }
    },
  }
}

/** Every call shows the conversation's page as operated by the AI while it runs. */
function operating(ctx: BrowserContext, definition: SdkMcpToolDefinition): SdkMcpToolDefinition {
  const handler = definition.handler
  return {
    ...definition,
    handler: async (args, extra) => {
      ctx.beginToolCall()
      try {
        return await handler(args, extra)
      } finally {
        ctx.endToolCall()
      }
    },
  }
}
