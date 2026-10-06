# Browser carrier regression

The carrier suite exercises webview guests in the running application. Run it
against a fresh build, one Electron application at a time:

```sh
npm run build
npm run test:e2e -- --project=browser-view-frame
```

`browser-carrier-packaged` launches a packaged app instead of the source build.
Build it first (`npm run build:mac` on macOS) or point `HALO_E2E_PACKAGED_APP` at
the executable:

```sh
npm run test:e2e -- --project=browser-carrier-packaged
```

## Prerequisites

- Node 22.14 or newer for the runner and SQLite seeding.
- macOS: Xcode Command Line Tools. The clipboard fixture compiles
  `fixtures/clipboard-macos.swift` with `xcrun swiftc`; without the tools those
  clipboard cases fail with a clear error. Other platforms use Electron's
  clipboard API.
- Linux: a running window manager, so the parked/minimized/hidden case can really
  minimize the window. Run as an ordinary user with a writable output directory.
- `HALO_E2E_NO_SANDBOX=1` adds `--no-sandbox` where the container cannot provide
  Chromium's sandbox.

The fixtures isolate Halo data and Chromium storage. `fixtures/browser-site.ts`
serves a deterministic local site (inputs, a tall document, a color field, a
timer, an upload control, a download and a PDF); no production profile, external
model or network service is needed.

## What each spec proves

A passing case must observe the guest itself: its WebContents identity, a random
document nonce, unsaved input, scroll position and freshly painted pixels. Finding
a DOM node, or a Playwright result influenced by focus emulation, is not enough.

| Behavior | Spec |
|---|---|
| Hide/show, tab switching, collapse, Settings return and fullscreen keep the same guest, nonce, draft and scroll | `browser-view-frame` |
| A parked, minimized or hidden host still produces fresh frames, keeps timers and restores throttling and capturer counts; the user's composer keeps focus | `browser-view-frame` (native visibility runs without Playwright focus emulation) |
| React menus, the fullscreen chat capsule and the mobile resource sheet paint above the guest and receive the clicks | `browser-view-frame` |
| Login storage is shared through `persist:browser`; guests have no preload API and no Node access | `browser-view-frame` |
| Navigation history hides the attachment document; zoom, H5 mode and native keyboard input work | `browser-view-frame` |
| Main-renderer reload or crash releases its guests and the recovered UI creates a fresh one; a guest crash can reload in place | `browser-view-frame` |
| The six-guest budget releases the oldest hidden guest and recreates it only on activation | `browser-view-frame` |
| Unsolicited and replayed attachments are refused in the running app | `browser-view-frame` |
| Local PDFs render in Chromium's viewer and survive switching | `browser-view-frame` |
| Native and MCP screenshots are fully opaque for default, dark and explicit backgrounds | `browser-view-reveal` |
| The production MCP tools act on the watched guest, including upload, silent download, drag, keyboard and editing in iframes | `browser-view-reveal` |
| Editing shortcuts and paste respect the page's own cancellation and never touch the host editor | `browser-view-reveal` |
| Unattended runs use the hidden host and survive a main-renderer reload | `browser-view-reveal` |
| Tab ownership isolates automation; destroying a guest reconciles the AI pointer | `browser-view-reveal` |
| Cancellation returns frames, pressed input and remote objects; late replies cannot start input or revive a guest | `browser-view-reveal` |
| Browser policy blocks creation, navigation, redirects and popups | `browser-view-reveal` |
| Server mode runs watchable contexts, automation and search without a main window | `browser-carrier-server` |
| The packaged app captures its guest and serves the remote web app | `browser-carrier-packaged` |

`browser-view-frame.spec.ts` drives the full application through its public IPC.
`browser-view-reveal.spec.ts` uses a small Electron launcher that bundles the
production browser transport, manager, renderer host and AI MCP server; its
test transport calls the production MCP handlers instead of simulating a model.

Focused unit tests for the same contracts:

```sh
npm run test:unit -- tests/unit/services/browser-host.test.ts tests/unit/services/browser-frame.test.ts tests/unit/services/browser-capture.test.ts tests/unit/services/browser-input.test.ts tests/unit/services/browser-input-operation.test.ts tests/unit/services/ai-browser/context-cancellation.test.ts tests/unit/renderer/browser-host.test.ts
```

## Performance comparisons

Comparisons between runtimes or carriers use `tests/perf` on the same machine,
run serially with no other build or VM load, and record machine load with each
run. Both arms must use identical fixture bytes, verified by
`tests/perf/build-identity`. Report missing or incomplete samples explicitly,
never as zero. A heavy-page comparison is valid only with a fully opaque frame.
`s1b-native-idle` measures native idle CPU with Darwin cumulative counters and
runs on macOS only. Run results stay under the ignored `tests/perf/results/`;
summarize them in the change description rather than in this file.
