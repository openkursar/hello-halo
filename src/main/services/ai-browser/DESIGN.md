# AI Browser Module — Design

> For AI developers: Read this before modifying the AI Browser module.

## Architecture

The AI Browser module provides 14 browser control tools via an in-process MCP server.
Tools are exposed with prefix `mcp__ai-browser__` (e.g. `mcp__ai-browser__browser_click`).

```
                      ┌─────────────────────────────────────┐
                      │  createAIBrowserMcpServer()          │
                      │  (sdk-mcp-server.ts)                 │
                      │                                      │
                      │  PRIMARY ENTRY POINT                 │
                      │  All side effects init here          │
                      └──────────┬──────────────────────────┘
                                 │
            ┌────────────────────┼────────────────────┐
            │                    │                    │
   installDownloadHandler()   buildAllTools(ctx)   ctx.workDir
   (download-handler.ts)      (tools/index.ts)
            │                    │
   session-level             15 tool functions
   will-download handler     grouped by category
```

## Tool Inventory (14 tools)

| Category | Tools | File |
|----------|-------|------|
| Navigation (2) | `browser_navigate`, `browser_wait_for` | `tools/navigation.ts` |
| Input (5) | `browser_click`, `browser_fill`, `browser_hover`, `browser_press_key`, `browser_upload_file` | `tools/input.ts` |
| Snapshot (3) | `browser_snapshot`, `browser_screenshot`, `browser_evaluate` | `tools/snapshot.ts` |
| Script (1) | `browser_run` | `tools/script.ts` |
| Tab (1) | `browser_tab` | `tools/tab.ts` |
| Inspect (1) | `browser_inspect` | `tools/inspect.ts` |
| Download (1) | `browser_download` | `tools/download.ts` |

### Merged Tools (28 → 14)

Several tools were consolidated by intent:

| New Tool | Absorbed | Mechanism |
|----------|----------|-----------|
| `browser_navigate` | URL navigation | URL-only; creates the first page automatically |
| `browser_click` | + `browser_drag` | `dragTo` param |
| `browser_fill` | + `browser_fill_form` | `elements` array param |
| `browser_tab` | `browser_new_page` + `list_pages` + `select_page` + `close_page` | `action` param dispatch |
| `browser_inspect` | `console` + `console_message` + `network_requests` + `network_request` | `target` param dispatch |

### Retired Tools (code preserved)

The following tools are NOT registered in `buildAllTools()` but their code is
preserved in source files for future extension (e.g., developer tools mode):

| File | Tools | Reason |
|------|-------|--------|
| `tools/navigation.ts` | `browser_handle_dialog` | Electron cannot reliably intercept native JS dialogs |
| `tools/emulation.ts` | `browser_emulate` | Developer scenario |
| `tools/performance.ts` | `browser_perf_start`, `browser_perf_stop`, `browser_perf_insight` | Developer scenario |
| `tools/network.ts` | `browser_network_requests`, `browser_network_request` | Replaced by `browser_inspect` |
| `tools/console.ts` | `browser_console`, `browser_console_message` | Replaced by `browser_inspect` |

To re-enable any retired tool, import its builder in `tools/index.ts` and
spread into the `buildAllTools()` return array.

## Entry Points

`createAIBrowserMcpServer()` is the **sole primary entry point** for tool/session
side effects (download handler, future monitoring, etc.), initialized here
idempotently — not in a separate init function.

**Transport is the one exception:** view-lifecycle event *forwarding*
(`registerAIBrowserHandlers()` in `ipc/ai-browser.ts`) is wired once at startup
from `bootstrap/extended.ts`. It only subscribes the process-global bus to the
window/WS layer — it does not touch tool state — and must exist before the first
AI turn so the very first `active-view` event reaches the renderer.

### Callers

| Path | File | Context |
|------|------|---------|
| Main chat | `services/agent/send-message.ts` | Global singleton (no scoped ctx) |
| App chat | `apps/runtime/app-chat.ts` | Scoped context |
| Automation | `apps/runtime/execute.ts` | Scoped context |

### Adding new session-level side effects

When a new feature requires a one-time session setup (e.g. registering event
listeners on the Electron session), add the idempotent initialization call
inside `createAIBrowserMcpServer()`, NOT in a separate init function. This
guarantees the effect is active before any tool can trigger it, regardless
of which caller path is used.

## Context Model

```
BrowserContext (singleton)          — used by main chat (interactive UI)
BrowserContext (scoped, per-agent)  — used by app-chat / automation (no UI)
```

Scoped contexts are created via `createScopedBrowserContext()` and passed
to `createAIBrowserMcpServer(scopedCtx, workDir)`. They isolate view ownership,
download tracking, and monitoring state per agent session.

The context holds **no BrowserWindow reference**. UI notifications go through a
process-global event bus (see "View Lifecycle Events"), so delivery is owned by
the transport layer, not the context. Only the singleton (non-scoped) emits;
scoped automation contexts stay silent.

## View Lifecycle Events

The interactive singleton broadcasts its view lifecycle to `events.ts` (a
process-global bus, modeled on `ai-terminal/events.ts`). The transport module
`ipc/ai-browser.ts` subscribes once at startup and fans events to the
BrowserWindow + remote WebSocket clients:

| Event | Channel | Meaning | Renderer effect |
|-------|---------|---------|-----------------|
| active-view | `ai-browser:active-view-changed` | AI created/selected a view | `activeViewId` → "View live feed" attaches the exact view; identity for the operating indicator |
| gone | `ai-browser:view-gone` | AI's active view destroyed | store clears; live-session tray drops it |

`gone` is emitted from `context.handleViewDestroyed(viewId)`, invoked by the
`browser:destroy` IPC handler (covers canvas-tab close and the live-session tray
"stop"). This keeps `activeViewId` from dangling on a dead WebContents.

The renderer reveals the AI's view by **viewId identity** (`attachAIBrowserView`),
never by re-opening the URL — so the user sees and can take over the exact page
the AI drives (shared `persist:browser` session across all views).

### Lifecycle

- **Creation**: Caller creates scoped context → passes to MCP server factory
- **Cleanup (scoped)**: Caller calls `ctx.destroy()` when the agent session ends
- **Cleanup (singleton)**: `cleanupAIBrowser()` called by `bootstrap/extended.ts` on app shutdown

## File Map

| File | Responsibility |
|------|---------------|
| `index.ts` | Public API: re-exports, system prompt, cleanup, event-bus subscribers |
| `sdk-mcp-server.ts` | MCP server factory (primary entry point) |
| `events.ts` | Process-global view-lifecycle bus (active-view / gone); transport subscribes here |
| `context.ts` | BrowserContext class (state, CDP, element ops, downloads); emits view lifecycle |
| `snapshot.ts` | Accessibility tree snapshot creation |
| `download-handler.ts` | Session-level `will-download` handler for silent AI downloads |
| `download-utils.ts` | Shared filename sanitization / unique path resolution |
| `types.ts` | Type definitions |
| `tools/` | Tool implementations by category (14 active tools) |
| `tools/index.ts` | Tool aggregation (`buildAllTools`) |
| `tools/helpers.ts` | Shared tool utilities |

## Download Architecture

AI-initiated downloads bypass the native Save-As dialog via a session-level
`will-download` handler on `persist:browser`:

```
wc.downloadURL(url)
  → Electron fires will-download on persist:browser session
    → download-handler.ts routes to owning BrowserContext
      → ctx.registerDownload() sets savePath (silent save)
        → ctx.updateDownloadProgress() resolves waitForDownload()
```

The routing uses `contextsByWebContentsId` Map (webContents ID → BrowserContext),
populated by `ctx.trackView()` when `browser_navigate` or `browser_tab` creates a view.

## Design Principles

1. **One intent = one tool** — Tools map to AI reasoning intents, not browser primitives.
2. **Description as teaching** — Each tool description is a complete usage manual with examples, troubleshooting, and cross-references.
3. **Closed-loop references** — Every interaction tool reminds the AI to re-snapshot after use.
4. **Escape hatch pattern** — `browser_evaluate` covers any edge case that dedicated tools cannot handle.
5. **Extensible by re-registration** — Retired tools can be brought back by uncommenting imports in `tools/index.ts`.
