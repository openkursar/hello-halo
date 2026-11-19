# Browser Live View

Streams a server's browser page to a remote client (a browser tab, a phone),
which cannot host the page itself.

Server mode only. The desktop app does not use this: there a canvas browser tab
owns the real `<webview>`, which is faster and interactive. A remote client of a
desktop is refused (`browser-live-attach` answers `unsupported`, and
`/api/browser/*` declines) and keeps the plain link fallback.

## Who may watch

A page shows whatever the AI has signed into, so watching is as privileged as
operating. Every live message (attach, detach, ack, detail, input) requires the
install owner's `remote-control` credential. An `office-member` session, a peer
node or a team viewer, is always refused, whatever view id it names. The HTTP
routes are `expose: 'internal'` (denied to the self-API) and outside the
office-member allowlist.

## Why it exists

A page can block on something only a human can do — scan a QR code, read a
number off an authenticator. In server mode every page lives on a hidden host
window, so without a way to see it the only recourse is asking the model to
describe the page, which is slow and, for a QR code, useless.

## Operating the page

A viewer can click, scroll and type on the page it watches, to take over a step
only a person can do. It is not a remote desktop: there is no cursor stream, no
drag-and-drop of files, no native popup (a `<select>` dropdown or an `alert`
renders outside the captured surface).

- Positions and deltas arrive as fractions of the frame and are scaled to the
  page's DIP viewport measured with the last changed frame, so the client never
  needs the page's real size and a Retina capture does not skew aim.
- Mouse and wheel go through the page's own `sendInputEvent`; keys and text
  through `browser-input`, so a composed IME string or a paste arrives as text
  rather than as key codes the page would misread.
- Each viewer's held keys and buttons are tracked (`input.ts`) and released
  when it leaves, so a dropped socket cannot leave Shift or a mouse button down.
- Only the install's owner may operate (`remote-control` credential), the
  same rule as watching.
- Anything other than hover reports through `browserViewManager.noteUserInput`,
  which is how the AI driving the page learns its view of it is stale.

## Watching is explicit

Opening the page's canvas tab attaches the viewer; switching tabs, collapsing
Canvas, hiding the client, or disconnecting detaches it. There is no separate
watch/operate mode. An eligible remote owner learns support from the existing
WebSocket authentication reply; a desktop-backed web client keeps its link,
without probing browser endpoints. No stream runs for a page nobody is viewing:

- the frame lease is taken on the first viewer and released by the last one,
  restoring the page's original background-throttling policy
- the capture loop exits with the last viewer; the destroy listener and the
  state heartbeat are torn down with the last session

## Pacing

A viewer acknowledges the frames it rendered, and a viewer that owes two frames
stops being sent more. Only frames actually sent to that viewer count; an
acknowledgement cannot accelerate capture. Capture starts are at least 250 ms
apart, 1 s apart for a still page and at least 100 ms apart after input. The
socket also caps queued image bytes, and input waiting on the page is bounded.

Each changed frame carries the page's scroll position (`scroll`), measured in
an isolated world and abandoned after 300 ms, since a page blocked in a modal
dialog runs no script. The frame shows one screen of a taller page; the
position tells the viewer where that screen sits.

Frames are 1024 px wide JPEG at quality 40. The stream answers "where is the
page now", for which latency beats fidelity. Static pages still incur slow
capture and encoding while somebody watches, but matching frames are not resent.

That bitrate cannot carry a QR code a phone camera has to read, so a viewer can
ask for one high-quality still outside the stream (`detail`). Large stills are
scaled down and may be encoded as JPEG to stay within the 2 MiB encoded limit.

## Reaching the rest of a taller page

A frame is one screen. Two ways reach the rest, both landing through a
`scroll-to` input (a document position in CSS pixels, applied with an instant
`scrollTo` in the isolated world, so a page styled for smooth scrolling lands
before the next frame):

- the viewer's scrollbar, drawn from `scroll`, can be pressed or dragged;
- a `detail` request with `scope: 'page'` returns one image of the document from
  its top, with `page` saying which document range it covers. Clicking a spot
  centres the page on it.

`full-page.ts` scrolls the document a screen at a time, captures each screen
through the same surface copy as the stream, stitches the slices (1024 px wide
JPEG) and scrolls the page back. It stops at the earliest of the 12,000 CSS px,
16 MiB bitmap, 24-screen or time budgets and reports partial coverage. CDP
`captureBeyondViewport` is not used: on a hidden host window it waits for a
compositor frame that never comes, and when frames are forced it returns tiled
garbage. Stream frames pause while the screens are taken, so the viewer does not
see the page run down and back.

The stitched image is not quite the page as read: a bar fixed to the screen
repeats once per screen, content still loading when its screen is taken is
missing, and a page that scrolls inside its own container instead of the
document is no taller than its screen. When the capture fails, the screen alone
answers, placed by `scroll`, so the viewer is never left waiting.

## Ending a stream

Four paths end it, and each one tells the viewer why rather than letting frames
simply stop:

| trigger | reason |
|---|---|
| viewer detached, or its client disconnected | none — it asked |
| view destroyed (`onViewDestroyed`), page's `WebContents` gone | `gone` |
| frame lease or capture failed | `unavailable` |
| frames owed for 10 s with no acknowledgement | `stalled` |

The stall timeout matters: a viewer whose socket is still open but is no longer
reading would otherwise hold the frame lease, and with it the page's
no-throttling state, indefinitely.

## Dependencies

`browser-host` for the lease and the capture attempt, `browser-view.service` for
`viewId → WebContents`, destruction and reporting user input, `browser-input`
for keys and text. Nothing else, and in particular nothing
from `ai-browser`: this module streams *a page*, not an agent's page.

Delivery is inverted. A viewer attaches with its own sink, so this module never
learns about IPC or WebSockets. The transport decides how a frame reaches a
viewer and reports a dead link by returning false from the sink.

## Transport

The remote viewer uses the owner's authenticated WebSocket. The transport only
attaches it to pages already exposed by interactive conversation contexts;
unattended pages stay out. The model's HTTP self-API cannot use this surface.
Server deployments should serve the remote client over HTTPS (including WSS),
through a trusted reverse proxy, because pages and input may contain private data.
