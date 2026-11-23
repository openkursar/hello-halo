# Website Chrome API compatibility

This module supplies the Chrome-specific hosted-app and legacy timing APIs that
Electron does not expose to ordinary websites. It is not an identity or network
policy: it changes no user agent, credentials, requests, domains or browser security
preferences. The page script has no Node, IPC or host bridge.

`chrome-api.ts` is self-contained page-world code. It preserves existing APIs and
provides `chrome.app` for non-hosted browser documents, `chrome.csi()` and
`chrome.loadTimes()` from the document's own Performance data. Navigation Timing
cannot distinguish links from form submissions, so those report `Other`; alternate
protocol availability is not exposed and reports false. These are compatibility
implementations, not a claim of native Chrome provenance. Nothing overrides
`Function.prototype.toString` or grants permissions.

`index.ts` owns one controller per WebContents, held weakly until page destruction.
Creation awaits root registration before external navigation. The root and each child document have a bounded 1.5-second total setup budget; installation failure is logged once and callers continue ordinary navigation without the optional legacy APIs. Destroyed pages still reject, and callers retain lifecycle checks. Page-domain scripts
also initialize existing contexts through `runImmediately`; they never evaluate
into a missing child execution context. Auto-attachment covers descendant targets,
pauses documents for bounded installation and resumes them even after failure.
Workers are immediately resumed without page API injection: filtering them out
with a pausing auto-attach can strand them without an event in Electron.
Input operations retain their own explicit child
sessions and are not adopted by this controller. Each root or child document setup
has one total 1500 ms wait budget, not a fresh budget per command. Installation
failure is best-effort: it logs once and resolves so navigation and login can proceed.
Successful and pending registration steps are retained across retries, so a late
script-registration result cannot create duplicate registrations or continue an
expired setup. Child cleanup allows up to 250 ms each for resume and session release;
workers receive one immediate resume and are then released without injection.
These bounds limit host waiting, not Chromium's native command execution: if both
resume and release fail, the module logs the failure but cannot prove native recovery.
Native detachment invalidates in-flight continuations before any recovery begins.
A paused child page receives early API installation but no recursive auto-attach;
its own WebContents controller owns descendant sessions.

AI monitoring shares the root debugger. Releasing an AI context removes its own
monitoring but does not disable Page or detach a debugger retained here. A native
detach invalidates registration; the next main navigation or DevTools closure
reinstalls it. Page destruction removes listeners and child-session bookkeeping,
then detaches the retained debugger while it can still be released. The page's
DevTools host holds an attached debugger by raw pointer, and a webview guest's
WebContents is destroyed before its host removes the frame; a debugger left
attached can be garbage-collected in between and crash the main process when the
frame goes. There is no background polling or per-request interception. Work is
bounded by live documents and occurs only when creating a document or calling a
legacy API.

Browser views, including hidden automation pages, initialize through the page
manager. Standalone login windows wait before leaving their loading document.
Native popups share their opener's session and receive their own controller;
the opener's paused child-target path covers early script execution.
