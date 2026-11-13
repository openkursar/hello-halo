/**
 * AI Browser SDK MCP Server
 *
 * Creates an in-process MCP server using Claude Agent SDK's
 * tool() and createSdkMcpServer() functions.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ ENTRY POINT MANIFEST                                           │
 * │                                                                 │
 * │ createAIBrowserMcpServer() is the PRIMARY entry point for the  │
 * │ AI Browser module. All session-level side effects (download     │
 * │ handler, etc.) MUST be initialized here — not in a separate    │
 * │ init function — because this is the only path guaranteed to    │
 * │ run before any tool is called.                                  │
 * │                                                                 │
 * │ Callers:                                                        │
 * │   1. services/agent/send-message.ts  — Main chat (global ctx)  │
 * │   2. apps/runtime/app-chat.ts        — App chat (scoped ctx)   │
 * │   3. apps/runtime/execute.ts         — Automation (scoped ctx) │
 * │                                                                 │
 * │ When adding new session-level side effects, add them HERE.     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Tool implementations live in tools/ by category (14 active tools):
 *   tools/navigation.ts  — 2 active (navigate, wait_for) + 1 retired (handle_dialog)
 *   tools/input.ts       — 5 tools (click, fill, hover, press_key, upload_file)
 *   tools/snapshot.ts    — 3 tools (snapshot, screenshot, evaluate)
 *   tools/script.ts      — 1 tool  (run)
 *   tools/tab.ts         — 1 tool  (tab: list/select/close)
 *   tools/inspect.ts     — 1 tool  (inspect: network/console)
 *   tools/download.ts    — 1 tool  (download)
 *   tools/helpers.ts     — shared utilities (withTimeout, textResult, etc.)
 *
 * Retired (code preserved, not registered):
 *   tools/network.ts, tools/console.ts, tools/emulation.ts, tools/performance.ts
 *   tools/index.ts       — aggregation (buildAllTools)
 */

import { createSdkMcpServer } from '../agent/resolved-sdk'
import { browserContext, type BrowserContext } from './context'
import { buildAllTools } from './tools'
import { installDownloadHandler } from './download-handler'
import { AI_BROWSER_DESCRIPTION, AI_BROWSER_INSTRUCTIONS } from './guidance'

/**
 * Create AI Browser SDK MCP Server.
 *
 * This is the primary entry point for the AI Browser module. All
 * session-level side effects are initialized here (idempotently).
 *
 * @param scopedContext - Optional scoped BrowserContext for isolation.
 *   When provided, all tools operate on this context's activeViewId
 *   instead of the global singleton. Use for automation runs.
 *   When omitted, uses the global singleton (interactive user use).
 * @param workDir - Optional working directory for resolving relative paths in
 *   browser_run. Should match the cwd passed to the Claude SDK session so that
 *   relative skill paths (e.g. ".claude/skills/xhs-search/index.js") resolve
 *   correctly. Stored on ctx.workDir; defaults to process.cwd() at use-time
 *   when omitted.
 */
export function createAIBrowserMcpServer(scopedContext?: BrowserContext, workDir?: string) {
  // ── Session-level side effects (idempotent) ──────────────────────
  // Register the will-download handler on persist:browser session so
  // AI-initiated downloads are saved silently (no Save-As dialog).
  installDownloadHandler()

  // ── Build context and tools ──────────────────────────────────────
  const ctx = scopedContext ?? browserContext
  if (workDir !== undefined) {
    ctx.workDir = workDir
  }
  const tools = buildAllTools(ctx)
  return createSdkMcpServer({
    name: 'ai-browser',
    version: '1.0.0',
    description: AI_BROWSER_DESCRIPTION,
    instructions: AI_BROWSER_INSTRUCTIONS,
    tools
  })
}
