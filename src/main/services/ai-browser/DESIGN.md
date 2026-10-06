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
| App chat | `apps/runtime/app-chat.ts` | Scoped context bound to the chat's conversationId (`apps/runtime/app-chat-browser.ts`) |
| Automation | `apps/runtime/execute.ts` | Scoped context |

### Adding new session-level side effects

When a new feature requires a one-time session setup (e.g. registering event
listeners on the Electron session), add the idempotent initialization call
inside `createAIBrowserMcpServer()`, NOT in a separate init function. This
guarantees the effect is active before any tool can trigger it, regardless
of which caller path is used.

## Context Model

```
BrowserContext (singleton)            — the user's own browsing (Content Canvas / IPC)
BrowserContext (interactive, per-conv) — used by main chat, one per conversation
BrowserContext (scoped, per-chat)      — digital-human chat: hidden pages, announced under its conversationId
BrowserContext (scoped, per-run)       — automation: hidden pages, no conversation, silent
```

Scoped contexts are created via `createScopedBrowserContext()` and passed to
`createAIBrowserMcpServer(scopedCtx, workDir)`. Interactive ones come from
`getInteractiveBrowserContext(conversationId)` and are dropped by
`releaseInteractiveBrowserContext` when the agent session is cleaned up.

### Who may see and touch which tab

Views live in one process-wide `browserViewManager`, so **ownership is enforced
in the context, not the manager**: `visibleViewStates()` / `canReachView()` are
the boundary, and every tool that enumerates or targets a tab goes through them.
Two rules, from whom the tab belongs to:

- an **automation** sees only the tabs it opened itself;
- an **interactive** context sees the user's tabs and never an automation's —
  the user asked about the page in front of them.

Both were previously unenforced: tools read `getAllStates()` directly, so any
agent could list, select and navigate any other agent's pages *and* the user's.
The victim keeps pointing at the same view id, so its next snapshot silently
returns someone else's page — no error, no signal. `ownedViewIds` existed but
was only a cleanup list; nothing consulted it before acting.

What is deliberately **not** isolated: the Electron session partition
(`persist:browser`). Cookies and logins are one pot on purpose, so a digital
human can use sites the user is already logged into.

A conversation's active tab is its own; the tabs themselves stay shared. One
shared `activeViewId` meant a navigation in one conversation retargeted the next
tool call of another, which is why the pointer is per conversation while
visibility is not.

`release()` vs `destroy()`: an automation's tabs are closed with it; a
conversation's are the **user's** and stay open. Separate calls rather than one
flag — getting it wrong is silent and destroys the user's work.

The context holds **no BrowserWindow reference**. UI notifications go through a
process-global event bus (see "View Lifecycle Events"), so delivery is owned by
the transport layer, not the context. A context emits iff it has a UI
(`ctx.hasUi`): the singleton, every interactive per-conversation context, and
every scoped context created with a `conversationId` (digital-human chat).
Automation runs (scoped, no conversation) stay silent.

## View Lifecycle Events

Every context with a UI broadcasts its view lifecycle to `events.ts` (a
process-global bus, modeled on `ai-terminal/events.ts`). The transport module
`ipc/ai-browser.ts` subscribes once at startup and fans events to the
BrowserWindow + remote WebSocket clients:

| Event | Channel | Meaning | Renderer effect |
|-------|---------|---------|-----------------|
| active-view | `ai-browser:active-view-changed` | a conversation's AI created/selected a view; payload `{conversationId, spaceId, viewId, url, title}` | renderer store keeps the active view per conversation ("View live feed" and the operating indicator of the conversation on screen) and every page per viewId (the tray) |
| gone | `ai-browser:view-gone` | a view a UI context held — its active page or any other it opened — was destroyed; payload `{viewId}` | store drops the page and any active entry pointing at it; canvas tabs attached to it close |
| conversation-released | `ai-browser:conversation-released` | a UI context ended (`release()` or `destroy()`); payload `{conversationId}` | store drops that conversation's views, operating state and owned pages, so a page it only selected (now the user's) is not left listed or stoppable as its own |

Payload types live in `shared/types/ai-browser.ts`. The renderer filters by the
active conversation; events go out with `broadcastToAll` (browser pages are
desktop-only, so remote clients ignore them). An event only fires on change, so a
renderer that starts late (reload) seeds itself with the request
`ai-browser:list-live-pages` (`listLivePages()`: every owned or active page of a
UI context, `active` marking the one it acts on).

**Live-session tray.** Lists every live AI page of the CURRENT space that a
conversation OPENED ITSELF (`owned` in the event/snapshot), one row each,
labelled "owner · page" (digital human name, or the space conversation's title)
with its own stop — not only the on-screen conversation's page. Never listed: a
page the conversation only selected (the user's own tab, another conversation's
page), and a page another conversation is currently on (`isPageInUseByOthers`,
re-checked at stop time) — stopping either would close it under someone else.
Remote clients get no stop control (no browser pages there); a refused stop is
reported, not swallowed. The decision is the main process's: the tray stop goes
through `ai-browser:stop-page` (`stopLivePage(viewId, conversationId)`), which
refuses `not-owned` unless that conversation's context opened the page and
`in-use` while any other context is on it; the renderer's check is only a fast
path and can be one event behind. Closing a canvas tab is the user's own action
and still goes through `browser:destroy` unchecked. The space
comes from the context (`spaceId`: `getInteractiveBrowserContext(conversationId,
spaceId)` for space chat, `acquireChatBrowserContext(…, spaceId)` for
digital-human chat); a page with no space is never listed. Rows are built by
`renderer/hooks/browser-live-sessions.ts`.
`gone` is emitted from `notifyViewDestroyed(viewId)`, which reconciles EVERY live
context and announces once — whenever a context with a UI owned the view or was
pointing at it, not only for the active page: a page the chat moved away from can
still be open in a canvas tab. It is wired to `browserViewManager.onViewDestroyed`
at module load, so whichever path destroyed the view (canvas-tab close, tray
"stop", an agent closing a tab, window teardown, a context ending) reaches it.
This keeps `activeViewId` from dangling on a dead WebContents — essential once a
context outlives a turn.

The renderer reveals the AI's view by **viewId identity** (`attachAIbrowser page`),
never by re-opening the URL — so the user sees and can take over the exact page
the AI drives (shared `persist:browser` session across all views).

### Lifecycle

- **Creation (scoped)**: Caller creates scoped context → passes to MCP server factory
- **Creation (interactive)**: `getInteractiveBrowserContext(conversationId)`, on demand
- **Cleanup (scoped)**: Caller calls `ctx.destroy()` when the agent session ends — closes its tabs.
  Digital-human chat contexts are owned by `apps/runtime/app-chat-browser.ts`,
  which keeps native chats' contexts resident between turns (idle/cap reaping)
- **Cleanup (interactive)**: `releaseInteractiveBrowserContext(conversationId)` from the
  toolset broker's per-conversation teardown — leaves the user's tabs open
- **Cleanup (singleton)**: `cleanupAIBrowser()` called by `bootstrap/extended.ts` on app shutdown

## Live View and Guest Ownership

Pages that a user can watch are created in a permanent main-renderer webview
host, including digital-human chat pages. Pure unattended runs and temporary
search pages use the lazy hidden renderer host (`offscreen: !ctx.hasUi`).
In explicit server mode every page uses that hidden host, including remote
conversations, because a chat UI does not imply a local main renderer exists.
A guest never moves between hosts. Showing, hiding, switching tabs and leaving
Canvas change presentation only, preserving the same WebContents, DOM, form
state, CDP target and download route. `ctx.hasRevealedView()` still protects a
watched page from idle reaping.

The browser manager delegates DOM attachment to `services/browser-host` through
its public surface. Initial attachment is inert and authorized; policy, UA and
CDP setup precede external navigation. Canvas budgets and AI ownership contracts
continue to determine actual page destruction. A main-renderer reload loses its
guests: the manager announces destruction, unregisters download routing and
rejects pending waits; the next navigation creates a new page. Hidden-host pages
remain independent of a main-renderer reload.

Keyboard input uses the guest-targeted adapter in `services/browser-input`:
CDP keyboard dispatch and generic WebContents editing helpers can reach the
focused host composer. Native `sendInputEvent` / `insertText` target the guest;
editing shortcuts must operate on that guest's editable DOM. Frame leases cover
the complete input operation. `sendCDPCommand` routes `Input.*` commands to the
operation's `BrowserInputOperation`, which records what the page saw pressed and
releases it on the original page before the lease ends, including cancellation.
See the browser-host design for targeting and cleanup constraints.

Element helpers in `snapshot.ts` (scroll, box, focus) tolerate only a
`PageCommandRejectedError`: the operation's still-current page refused that one
command, as before, so a hidden element degrades to a full screenshot. Any other
error (cancellation, deadline, page loss) propagates unchanged.

`browser_fill` clears a field with the page's own select-all and types the
text, then reads back what the element holds one task later (`fill-check.ts`).
It types only while focus is on the element, inside it, or on the editing host
or shadow host around it: focus that stayed elsewhere would put the text into
another field, so that fill fails with nothing typed. Only a match is reported
as filled. A field holding anything else (reformatted, cut short, refused, or
appended to old text) is reported with what it holds, a password field by
length only; an element with nothing to read back is reported as unconfirmed.
An option chosen from a list is not read back.

On macOS the editing adapter respects the guest's trusted Meta-key handler and
its `preventDefault`. Its paste fallback delivers a synthetic clipboard event
and guest-local DOM insertion, including rich HTML; it does not provide a
trusted native paste event. The browser-host design records this distinction.

## File Map

| File | Responsibility |
|------|---------------|
| `index.ts` | Public API: re-exports, system prompt, cleanup, event-bus subscribers |
| `sdk-mcp-server.ts` | MCP server factory (primary entry point) |
| `events.ts` | Process-global view-lifecycle bus (active-view / gone); transport subscribes here. Payload types: `shared/types/ai-browser.ts` |
| `context.ts` | BrowserContext class (state, CDP, element ops, downloads); emits view lifecycle |
| `snapshot.ts` | Accessibility tree snapshot creation |
| `fill-check.ts` | Reads back what a fill left in the field and compares it with the requested text |
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
