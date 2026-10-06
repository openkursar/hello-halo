# Browser carrier and Electron runtime

The embedded browser renders pages in standard Electron `<webview>` guests. React
menus and dialogs share the host's composition tree, so they can cover a page;
native `BrowserView` instances and the separate overlay window are gone. Browser
IPC methods keep their historical `BrowserView` names and response shapes; those
names now refer to browser pages, not a native carrier.

Module details live next to the code:
`src/main/services/browser-host/DESIGN.md` (attachment, trust, frame leases),
`src/main/services/browser-input/DESIGN.md` (input delivery),
`src/main/services/ai-browser/DESIGN.md` (AI ownership) and
`src/renderer/components/canvas/DESIGN.md` (presentation and layering).
This page records the decisions that span them.

## Ownership

- The browser manager (`browser-view.service.ts`) owns page identity,
  navigation, policy, user agent, zoom/device mode and page state.
- `services/browser-host` owns authorized guest attachment, the fixed hosts,
  presentation commands and temporary frame leases. It imports no renderer,
  agent or app runtime code.
- The renderer's `browser-host` keeps one fixed DOM node per page. A mounted
  viewer lends a geometry anchor; it never owns or reparents the guest.
- AI contexts keep their tab ownership, per-conversation active pointer, tool
  signatures and silent download routing.

Watchable pages, including digital-human chat pages, live in the main renderer's
permanent host. Unattended runs and temporary search pages live in one lazy
hidden host; in server mode every page does. Guests never move between hosts.
Unmounting a viewer, switching tabs or folding the canvas only changes
presentation; canvas budgets and AI context release decide destruction.

## Trust

The main window's preload is sandboxed and self-contained; the hidden host gets a
separate minimal preload that exposes only the attachment protocol, never the
Halo business API. Main authorizes every guest with an unpredictable token on an
inert `about:blank` URL, then strips preloads and forces sandbox, context
isolation, web security and disabled Node integration. Only the attached
WebContents whose first document carries that token is accepted. Remote clients
never initialize the desktop host.

## Lifecycle and recovery

- Close-to-tray keeps the main host alive on macOS and Windows; Linux keeps its
  real-quit behavior.
- Quit waits for one bounded shutdown: producers and SDK sessions stop before
  the compatibility router, remote access shuts down in parallel, and a deadline
  logs once and lets quit continue.
- A main-renderer reload or crash loses its guests. Page loss clears AI
  pointers, download routes and pending waits; hidden-host automation continues.
- A guest renderer crash keeps its WebContents so Reload restores it. Explicit
  close removes the page; a budget release keeps the tab and a later activation
  creates a new guest.
- Browser policy covers initial, explicit and page navigation, redirects and
  popups. Login, proxy and downloads share `persist:browser`.
- Desktop PDFs use Chromium's viewer. Geometry is in CSS pixels and follows
  local layout, so host zoom needs no DIP conversion.

## Runtime and native dependencies

- Electron is pinned to 43.7.7. The macOS floor is 12, set by Electron; Windows
  keeps its floor.
- better-sqlite3 13 loads its bundled Node-API 10 binary, so an Electron upgrade
  needs no ABI rebuild. Development tooling therefore needs Node 22.14+. Linux
  uses the stock binary, which requires glibc 2.34 (Ubuntu 22.04).
- Packaging checks every Mach-O in the app against the macOS 12 floor. The one
  declared exception is cloudflared: the upstream release targets macOS 15, so
  the remote tunnel needs macOS 15 while the app does not. See
  `docs/local-macos-builds.md`.
- File pickers go through `foundation/file-dialog`, which remembers the last
  directory; notification failures fall back to the in-app toast.

## Memory

Measured on one macOS machine against Electron 29.4.6, idle total RSS rises by
about 80 MB (roughly 15%), almost entirely from the Electron 43 runtime itself;
startup, idle CPU and heavy page loading improve. Re-measure with `tests/perf`
when changing the runtime or carrier; see `tests/e2e/browser-carrier-regression.md`.
