# Browser page hosts

The host owns the fixed DOM attachment of each Electron webview guest. The
browser manager continues to own navigation, policy, device emulation and public
page state; AI contexts continue to own their page permissions and CDP sessions.

## Ownership

Pages that a user can watch or take over are attached to the main renderer from
creation. Pages that can never be displayed use one lazily created hidden host.
The caller picks the host from whether anyone can watch the page (see the
ai-browser design, "Context Model"); this module never infers it, and never
moves a page to the other host on its own. A page never moves between hosts
after creation, and its webview DOM node is never reparented.
Parking changes its geometry and input visibility without removing the element.
React viewers may unmount: they borrow a presentation surface, not the guest.
Existing canvas budgets and AI session release rules determine actual destruction.

Explicit server mode has no local main renderer: every page uses the hidden host,
including pages owned by remote conversations. This is a runtime-mode decision,
not a fallback for a missing desktop window. The server bootstrap registers the
minimal host IPC bridge without creating a window, before automation can run.

## Creation and trust

Main allocates a page record with an unpredictable attachment token and an inert
about:blank creation URL. The host subscribes before requesting its initial page
snapshot. Commands only describe DOM attachment and presentation; they never
grant the renderer navigation or WebContents adoption authority.

Main validates the known host, the pending token and the shared browser partition
in will-attach-webview, forces sandbox/context isolation/web security and strips
preloads and Node access. did-attach-webview provides the actual WebContents.
The manager binds domain events and applies the configured user agent before
loading external content. Attachment has a bounded timeout; close, host reload
and shutdown reject pending creation and release records exactly once. A guest
renderer crash retains its WebContents so an ordinary reload can recover it.

Main-host attachment is the step that depends on the main window. On Windows it
has been seen to time out for every new page for over an hour while nobody was
at the computer, then recover by itself; one guest attached and never produced
its initial document, so the stall can lie on the guest side, not only in the
host renderer. Work nobody watches therefore never uses the main host. The
hidden host and its guests run with background throttling off, so they are
never marked hidden, whatever the main window's state.

A main-window attachment that times out, is refused while that renderer
restarts, or is released by its reload or crash rejects with
`MainHostAttachError`; nothing was wrong with the page, so a caller that need
not display it may create it again in the hidden host (closing a page, or the
window closing for good, rejects with a plain error). After a main-window
timeout `isMainHostStalled()` stays true until a page attaches there, its
renderer reports ready again, or the window is shown, restored or focused —
callers able to open a page elsewhere skip it meanwhile instead of waiting out
another timeout. Entering and leaving that state logs once each, the periodic
state line carries it, and the timeout warning records how far the attachment
got (`queued` before the host renderer received it, `sent`, `will-attach`,
`did-attach` with the guest's process id and whether it is alive) and whether
its window was visible or minimized.

## Transport and recovery

BrowserHostBridge is desktop-only. The hidden host has a dedicated minimal preload
with the same host protocol, without the Halo business API. Existing browser IPC
methods and state events retain their public behavior. Geometry uses renderer CSS
pixels, so host zoom does not require native DIP conversion.

Main window close-to-tray keeps the host alive. Renderer reload/crash destroys its
guests, announces page loss and lets a later browser operation create a new page.
Pure unattended pages in the hidden host remain independent of main UI routing.

## Temporary frame leases

Screenshots, input and page scripts borrow compositor frames through
`withBrowserFrames` (`frame.ts`); `captureBrowserPage` (`capture.ts`) is the
bounded native capture on top of it. Both are exported from this module's index
with `browserHostManager` (`manager.ts`). Each caller has an independent
preparation timeout and may supply an abort signal and an absolute deadline
covering preparation plus work. Callers sharing a guest share its preparation and
original throttling policy; different guests sharing a host share the host's
throttling lease, so a hidden-host page never touches the main window's. A
caller that joins after a shared preparation failed starts a new preparation
instead of inheriting that failure.

The last caller releases both policies even when the renderer has not acknowledged
frame readiness. Cancelling one caller never releases another caller's frames.
Host preparation has its own five-second fallback, and its release cancels the
readiness timer and signal listener. That fallback expiring is the one frame
failure logged (page, host, window visibility, whether the page was displayed);
an acknowledged, cancelled or released preparation logs nothing. The caller still guards commands after any
await: cancelling a returned promise cannot cancel an already-issued native
operation or page script.

## Guest keyboard targeting

For webview guests, Chromium's CDP keyboard dispatch can select the outer
focused widget even when the debugger target is the guest. Browser automation
therefore sends keys through the target guest's `WebContents.sendInputEvent`
and inserts text through its `WebContents.insertText`, without focusing the
host window or changing the user's composer focus.

WebContents editing helpers such as `selectAll`, `cut` and `paste` can also
delegate to the focused host widget. Guest editing commands must target the
guest's editable DOM through its own runtime, while native key and text events
stay addressed to that same guest. These paths belong to the browser input
adapter; callers must not substitute a generic WebContents editing helper.

On macOS, editing shortcuts first dispatch a native Meta-key event and wait for
the guest's trusted keydown acknowledgement. A page that calls `preventDefault`
keeps control of the shortcut. Otherwise copy, cut, undo and related editing
commands run against the guest document through `execCommand`.

Paste has a narrower contract: the adapter supplies clipboard text, rich HTML
or image data in a **synthetic** `ClipboardEvent`, respects cancellation, then
uses the guest's `execCommand('insertText' / 'insertHTML')` default insertion.
That insertion produces the browser's input and undo behavior, but the paste
event itself is not a trusted native paste event. A site that requires
`paste.isTrusted` is not covered by this fallback; trusted keydown or input
events must not be presented as proof of trusted paste support.

An operation tracks the keys and mouse buttons it pressed on its original
WebContents. Its `beforeRelease` hook releases that input while the frame lease
is still held, even on cancellation or timeout, with a separate 500 ms cleanup
limit. Cleanup cannot start a new browser action or target a replacement page.

## Validation

Tests must assert actual guest pixels and WebContents identity through hide/show,
tab and conversation switching, minimum-size and minimized windows. DOM existence
alone does not prove a compositor is producing frames. Security tests reject
unsolicited, duplicate and foreign-host attachment requests.
