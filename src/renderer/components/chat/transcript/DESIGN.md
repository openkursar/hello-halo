# Transcript scrolling

Primitives for every chat transcript: space chat and digital-human chat (one
page, `ChatView`), IM sessions and run detail (all through `MessageList`), and
team sessions (`team/TeamSessionChat`).

## Decision: no list virtualization

Chat rows vary widely in height and keep changing after they render (markdown
and highlighting passes, images decoding, thought panels expanding, the live
turn growing at the bottom), and reading is anchored to the end. A JS
virtualizer has to estimate unmounted rows and correct `scrollTop` as real
sizes arrive. Those corrections compete with the reader's own scrolling — the
view jumps, or cannot reach the end until enough rows have been measured.

So the browser owns row heights and the reader's scrolling. The code writes
`scrollTop` only in the few deterministic cases below, always from measured
positions, never from estimates. Cost is bounded instead by:

| Concern | Mechanism | File |
|---|---|---|
| Layout/paint of off-screen rows | `content-visibility: auto` + `contain-intrinsic-size: auto <estimate>` per row | `row.ts` |
| What each row needs from its neighbours (drawn or not, key, previous cost, injected messages) | Derived again only from the first message whose object changed; rows before it are kept. A change at the head (another conversation, an older page) or a repeated key builds them in full | `transcript-rows.ts` |
| How many rows React builds | Mount the newest N rows; mount older pages as the reader nears the top. At most `MAX_LIVE_ROWS` rows are live: past that, the rows farthest from the reader are retired to placeholders holding their **measured** height, and come back as the reader nears them. When the source pages older history in (digital-human transcripts), the window follows the rows it showed and the view stays on the same row; at the top of everything loaded it asks the source for more (`onLoadEarlier`). | `useHistoryWindow.ts` |
| Following new content | ResizeObserver re-pins to the end while following; upward intent (wheel, touch, keys, scrollbar grab) detaches immediately; growth the reader just caused (a click or key inside) is left in place unless a turn is live | `useStickToBottom.ts` |
| Keeping the view still when content above it changes size | The follower's own anchor: the first element starting inside the view keeps its position. Native `overflow-anchor` is off — the browser's anchor choice skips contained rows and can land on the live area at the end | `useStickToBottom.ts` |
| Restoring a reading position | Message id + offset, not scrollTop | `position.ts` |

Do not reintroduce a virtualizer for transcripts. Fixed-height lists
(conversation list, spreadsheet viewers) are a different case and use one.

### Retiring far rows (the live-row cap)

"Never unmount" held DOM and React work proportional to everything the reader
had scrolled through — a 2,000-message conversation read to the top is ~230k
nodes. The window therefore keeps a live range of at most `MAX_LIVE_ROWS`
(300) rows. A row leaving the range is measured first (one
`getBoundingClientRect` per retired row) and replaced by an empty element of
exactly that height, keyed like the row, so nothing around it moves. This is
not virtualization: a placeholder's height is the row's own last real height,
never an estimate, and rows above the oldest mounted one are still not
rendered at all. The one exception is a row appended while the reader is far
up (the live range does not reach the end): it has never rendered, so its
placeholder uses the row estimate until the reader comes near and it mounts.

- Scrolling up past the live range mounts the rows above it again (or older
  history) and retires rows at the bottom; scrolling down does the reverse
  through a sentinel after the last live row.
- `scrollToBottom` and a search jump (`reveal`) move the live range first.
- A jump that skips the sentinels (scrollbar drag, End/Home, a click in the
  track) is caught on scroll: if no live row is in the viewport, the rows at
  the viewport's top are made live (`recoverViewport`); reaching the end makes
  the newest rows live, so following never resumes over placeholders.
- Row estimates (`row.ts`) are tiered by content length, so a never-seen row
  entering the view shifts the scrollbar less.

## Rules for row content

Rows are contained (see `row.ts`):

- Anything that must escape the row — tooltip, menu, modal — is portaled to
  `document.body`. An in-row `position: fixed` element is trapped in the row.
- Do not read layout (`getBoundingClientRect`, `offsetHeight`) of every row;
  it forces skipped rows to render. Query the one row you need.
- Rows carry `data-transcript-index` (absolute index) where the history window
  is used; message elements carry `data-message-id`.
- Rows are keyed by `messageRowKey` (`utils/message-row-key`), never by index: a
  page prepended in front must not rebuild the rows below it, and an optimistic
  message keeps its bubble when its persisted twin arrives (`Message.clientKey`).

## Scroll ownership

Only these hooks write the transcript's `scrollTop`. Surfaces call
`scrollToBottom` / `scrollToMessage` on `MessageListHandle` rather than
touching the scroller. Jumps center the row on the scroller directly
(`revealRowInView`); `Element.scrollIntoView` would also scroll the app shell's
`overflow: hidden` ancestors. A far jump is instant and re-aimed for a few
frames, because the rows it crosses change from estimated to real heights as
it lands.
