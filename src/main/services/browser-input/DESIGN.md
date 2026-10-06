# Browser input

This module delivers input to a page without borrowing the user's focused
widget. The caller supplies its guarded command sender and a scope for one
bounded operation; it imports no AI context, app runtime or renderer module.

The page's main widget uses Electron native keyboard events and `insertText`.
Native dispatch returns before rendering consumes it, so key sequences retain
their frame lease until a trusted key acknowledgement completes.

An opaque focused iframe is selected from its actual DOM reference. Local
frames use a fixed isolated world for acknowledgement and editing. Remote frame
targets use their owned child debugger session for native CDP input; Chromium
routes child-target input directly to the child's widget. Main-target CDP input
and WebContents editing methods can select the outer focused widget.

`BrowserInputOperation` is the per-operation entry point. It dispatches CDP-shaped
`Input.*` commands and records a key or mouse button only while the page can have
seen it pressed: a rejected press is forgotten, a drag keeps its last position.
`release()` lifts what is still pressed on the original page, then disposes the
scope; the caller's frame lease invokes it before ending.

The scope owns temporary remote handles and child sessions. Acquisition records
resources before checking cancellation, including late protocol replies; release
cleans those resources before the caller returns its frame lease. No input is
sent after the caller's guard fails. Focus resolution follows the active frame
chain rather than matching URLs or enumerating unrelated targets.
`Page.getFrameTree` includes only local frames for its session. An omitted
remote frame is proved by the current session's connected frame-owner DOM node
and its corresponding target identity/parent, rather than rejected against a
root-only tree. Local trees are cached for the operation and refreshed only
when a new focused frame requires it.

macOS editing commands in a main/local widget require a targeted default after
the page permits its trusted key event. Paste invokes the target document's
clipboard handler with text, HTML and image formats, then applies the default
editing command if permitted. This fallback paste event is synthetic; its
insertion uses Chromium's trusted editing machinery. Child-target CDP uses
native clipboard events. Event objects are created in their recipient's realm.
