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
| Main chat | `services/agent/send-message.ts` (via the toolset broker, `services/agent/toolsets/registry.ts`) | Interactive context per conversation (`getInteractiveBrowserContext`), released with the agent session |
| App chat | `apps/runtime/app-chat.ts` | Scoped context from `apps/runtime/app-chat-browser.ts`: a native chat's has a live view under its conversationId; an IM, team or HTTP chat's is unattended |
| Automation | `apps/runtime/execute.ts` | Scoped context; a desktop Run once has a live view under its run key, every other run is unattended |

`browserContextOfServer(server)` returns the context a mounted AI Browser server
acts on. `services/browser-program-host` uses it to lend the same browser to
programs the session runs; see its DESIGN.md.

### Adding new session-level side effects

When a new feature requires a one-time session setup (e.g. registering event
listeners on the Electron session), add the idempotent initialization call
inside `createAIBrowserMcpServer()`, NOT in a separate init function. This
guarantees the effect is active before any tool can trigger it, regardless
of which caller path is used.

## Context Model

```
BrowserContext (singleton)              — the user's own browsing (Content Canvas / IPC)
BrowserContext (interactive, per-conv)  — used by main chat, one per conversation
BrowserContext (scoped, with liveView)  — someone can watch it: a native digital-human chat (under its
                                          conversationId) or a desktop Run once (under its run key);
                                          main-window pages, announced
BrowserContext (scoped, unattended)     — IM, team and HTTP digital-human chats and every other run:
                                          hidden-host pages, silent
```

Scoped contexts are created via `createScopedBrowserContext()` and passed to
`createAIBrowserMcpServer(scopedCtx, workDir)`. Interactive ones come from
`getInteractiveBrowserContext(conversationId)` and are dropped by
`releaseInteractiveBrowserContext` when the agent session is cleaned up.

A scoped context is watchable only when created with
`createScopedBrowserContext({ liveView: { conversationId, spaceId } })`; that
one option decides both where its pages are hosted and whether the renderer
hears of them. Nothing infers it from the caller having a conversation: IM,
team and HTTP chats have one but nobody can watch them, and they mostly run
while nobody is at the computer, which is when the main window has been seen
to fail every new page attachment on Windows (see the browser-host design).
Such a page announced to the renderer would offer a live view that cannot open.

**A watchable page the main window cannot attach.** Both tools open pages
through `ctx.openPage()`. When the main window fails to attach a watchable
page (`MainHostAttachError`: timed out, restarting, or lost its renderer
meanwhile), the same call opens the page in the hidden host instead and the
tool result tells the model the user cannot watch it live — a native chat woken
by a reminder while nobody is there still gets its page, as when every
digital-human page lived in the hidden window. Such a page joins the
process-wide `backgroundOnlyViewIds`: `isWatchable(viewId)` is false for every
context, so selecting it announces nothing, it is never listed, it gets no tab
that could end it, and its destruction is not announced. Like every other hidden-host
page, it is muted, its autoplay blocked and its visibility reported as visible
(`trackView`), in a space chat too. The context's other pages stay
watchable. While the browser host reports the main window stalled
(`isMainHostStalled()`), watchable pages skip it outright, so the timeout is
paid once rather than per page. A conversation's pages normally outlive
`release()` as the user's; a background-only one is closed with it, since
nothing could ever show it. Any other creation failure is not retried.

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

Both end the context for good: every later call fails with "Browser context was
released". `closePages()` is the third ending, the end of a **turn**: it closes
the pages the context opened and forgets its pointer, and the context stays
usable. The tools of an engine session (`createAIBrowserMcpServer` →
`buildAllTools(ctx)`) close over the context object they were built with, and
that session serves every later turn of its conversation with those same
tools; so a context may only be destroyed once no session can reach it any
more, while pages can go whenever their owner decides. A digital-human chat's
context is destroyed with its session (`apps/runtime/app-chat-browser.ts`); a
context destroyed under a live session left the chat's browser refusing every
call until the session idled out.

The context holds **no BrowserWindow reference**. UI notifications go through a
process-global event bus (see "View Lifecycle Events"), so delivery is owned by
the transport layer, not the context. A context emits iff it has a UI
(`ctx.hasUi`): the singleton, every interactive per-conversation context, and
every scoped context created with a `liveView` (a native digital-human chat,
and a run started with the desktop's Run once, under its run key
`app-run:{appId}:{runId}`). Every other scoped context — IM, team and HTTP
chats and every other run — stays silent: no event, no `listLivePages` entry,
nothing `stopLivePage` accepts.

## View Lifecycle Events

Every context with a UI broadcasts its view lifecycle to `events.ts` (a
process-global bus, modeled on `ai-terminal/events.ts`). The transport module
`ipc/ai-browser.ts` subscribes once at startup and fans events to the
BrowserWindow + remote WebSocket clients:

| Event | Channel | Meaning | Renderer effect |
|-------|---------|---------|-----------------|
| active-view | `ai-browser:active-view-changed` | a conversation's AI created or selected a view, or that active view's url/title changed (a page is picked before it loads; the manager's `onViewStateChanged` fires in server mode too); `owned` distinguishes the two relationships | update the active view per conversation without resetting when it was picked; keep page ownership separate |
| page-opened | `ai-browser:page-opened` | a watchable website child tab is ready; it belongs to the parent's AI context | add an AI tab in the same space without selecting the child or opening the canvas |
| gone | `ai-browser:view-gone` | a watched, owned or previously released page was destroyed; payload `{viewId}` | drop the page and active entries still pointing to it; close its tabs |
| conversation-released | `ai-browser:conversation-released` | a UI context no longer holds pages; payload `{conversationId}` | clear its selection and activity; adopt its surviving owned pages |
| operating | `ai-browser:operating` | a conversation's AI started, or stopped (10 s after its last browser tool call), operating its browser | mark the page the conversation actually operates, even when another conversation opened it |

Payload types live in `shared/types/ai-browser.ts`. Both desktop and remote
clients consume lifecycle events; only desktop shows the browser guest itself.
A Halo Server's remote clients watch it through the live view
(`services/browser-live`); a desktop's remote clients show a placeholder tab.
A late renderer reads `ai-browser:list-live-pages` (IPC) or
`GET /api/ai-browser/live-pages` (HTTP). The snapshot includes owned and active
pages, current activity, and surviving pages handed back to the user. On an
authenticated reconnect, remote clients read it once again to recover missed
changes, preserving newer events that arrived during the read.

**Operating.** Every browser tool built by `buildAllTools(ctx)` is wrapped to call
`ctx.beginToolCall()` / `ctx.endToolCall()`; contexts with a UI and a
conversation feed one process-wide hold per conversation
(`shared/ai-operating.ts`: on at the first call, off 10 s after the last). The
signal therefore holds for a conversation nobody has on screen, and no chat card
sets it any more. In server mode the same tools are first wrapped with the
user-input notice (below), so a call answered only with that notice still counts
as operating.

Page titles and URLs keep changing after creation, including on inactive pages.
`browser:state-change` carries those updates by `viewId`; the AI browser store
patches known pages and active references. Canvas updates the affected tab, not
tab membership in every space. Metadata changes do not establish ownership,
select a page, or reveal Canvas.

**The AI's pages are canvas tabs.** Every live page of a space that a
conversation OPENED ITSELF (`owned` in the event/snapshot) is a canvas tab of that
space, added quietly by `renderer/services/ai-work-tabs.ts` (no canvas opening,
no tab switch), titled after the page itself and marked as the AI's. A page the
conversation only selected (the user's own tab, another conversation's) gets no
tab of its own. Closing an AI page's tab asks once and ends the page through
`ai-browser:stop-page` (`stopLivePage(viewId, conversationId)`), which refuses
`not-owned` unless that conversation's context opened the page and `in-use`
while any other context is on it — the tab then stays and the user is told why.
The renderer's check (`isPageInUseByOthers`) is only a fast path. Remote clients
show the tab without a close (they hold no browser guests). When a conversation
is released (`conversation-released`) its surviving pages become the user's own:
their tabs take ownership (`canvasLifecycle.adoptPages`) and the mark goes.
Main retains the originating space for those guests until they are destroyed,
so removing a space also ends its released pages even if it was never reopened.
The space comes from the context (`spaceId` for space chat, the `liveView` for
a native digital-human chat or a Run once); a page with no space gets no tab.
`conversationPage(conversationId)` gives the page a conversation acts on;
`canvas_show` also checks that this conversation opened it in that space.
`gone` is emitted from `notifyViewDestroyed(viewId)`, which reconciles EVERY live
context and announces once — whenever a context with a UI owned the view or was
pointing at it, not only for the active page: a page the chat moved away from can
still be open in a canvas tab. It is wired to `browserViewManager.onViewDestroyed`
at module load, so whichever path destroyed the view (canvas-tab close, the
user closing an AI tab, an agent closing a tab, window teardown, a context ending) reaches it.
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
  which keeps every chat's context for as long as its engine session holds the
  tools built around it, keeps native chats' pages between turns (idle/cap
  reaping closes pages, `ctx.closePages()`) and closes IM, team and HTTP chats'
  pages with the turn — silently, since nothing about them was ever announced
- **Cleanup (interactive)**: `releaseInteractiveBrowserContext(conversationId)` from the
  toolset broker's per-conversation teardown — leaves the user's tabs open, except
  a background-only page, which nothing could show
- **Cleanup (singleton)**: `cleanupAIBrowser()` called by `bootstrap/extended.ts` on app shutdown

## Live View and Guest Ownership

Pages that a user can watch are created in a permanent main-renderer webview
host: the user's own, a space chat's, a native digital-human chat's and those of
a run the user started with the desktop's Run once. Everything nobody can watch
— IM, team and HTTP chats, every other run, temporary search pages — uses the
lazy hidden renderer host, so it neither depends on nor borrows frames from the
main window; so does a watchable page the main window could not attach (see
"Context Model"). In explicit server mode every page uses that hidden host,
including remote conversations, because a chat UI does not imply a local main
renderer exists; that is not a fallback, and those pages stay announced.
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

### The user operating the AI's page

A person watching through `browser-live` can click, scroll and type on the page
the AI drives. `browserViewManager.onUserInput` reports it (hover does not
count); a context whose `activeViewId` is that page holds one pending notice,
and invalidates its previous snapshot. The next browser call gets the notice
before acting: if it is not a snapshot, the call returns without running and
asks for a fresh snapshot. A snapshot itself may run and includes the notice.
No separate takeover, lock or hand-back mode interrupts a running turn.

### Text the model must not hold (server mode)

`browser_fill_secret` is registered only in server mode, where the person is not
at the page and would otherwise type a password or one-time code into the chat.
The model names fields by uid; `credential-broker.ts` emits
`ai-browser:credential-request` (origin, field labels, the model's stated
purpose), and the remote owner answers through internal HTTP routes. There is
no desktop IPC for credentials. The request is bound to the snapshot and page;
main-frame navigation or tool cancellation ends the wait. If field reads do
not confirm a fill, Halo does not submit. This keeps the submitted text out of
the chat and redacts the identified fields in later accessibility snapshots.
It is not an isolation boundary against the receiving website or everything
that can subsequently be read on that page.

## File Map

| File | Responsibility |
|------|---------------|
| `index.ts` | Public API: re-exports, short capability hint, cleanup, event-bus subscribers |
| `guidance.ts` | Resource-independent service description, short host hint and cross-tool instructions; reused by the registry and MCP factory |
| `sdk-mcp-server.ts` | MCP server factory (primary entry point) |
| `events.ts` | Process-global view-lifecycle bus (active-view / gone); transport subscribes here. Payload types: `shared/types/ai-browser.ts` |
| `context.ts` | BrowserContext class (state, CDP, element ops, downloads); emits view lifecycle |
| `snapshot.ts` | Accessibility tree snapshot creation |
| `fill-check.ts` | Reads back what a fill left in the field and compares it with the requested text |
| `credential-broker.ts` | Pending user-typed values for `browser_fill_secret` (server mode): one fill each, never persisted or logged |
| `download-handler.ts` | Session-level `will-download` handler for silent AI downloads |
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

The saved name is the server's name, sanitized (`foundation/file-naming`) and
made unique. A name an agent engine reads as its instructions
(`shared/engine-control-files`, compared the way Windows reads a name) is saved
as `CLAUDE (downloaded).md` and so on, in every turn: downloads land in the
workspace the engine works in. `browser_download` reports the name actually
saved.

In a restricted turn the browser's local file arguments and the addresses it
opens are judged by `apps/runtime` (`turn-file-access`, through the per-call
gate and pre-tool hook), not by the tools themselves.

## Design Principles

1. **One intent = one tool** — Tools map to AI reasoning intents, not browser primitives.
2. **Description as teaching** — Each tool description is a complete usage manual with examples, troubleshooting, and cross-references.
3. **Closed-loop references** — Every interaction tool reminds the AI to re-snapshot after use.
4. **Escape hatch pattern** — `browser_evaluate` covers any edge case that dedicated tools cannot handle.
5. **Extensible by re-registration** — Retired tools can be brought back by uncommenting imports in `tools/index.ts`.
