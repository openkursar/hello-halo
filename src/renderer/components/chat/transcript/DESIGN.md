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
| How many rows React builds | Mount the newest N rows; mount older pages as the reader nears the top. Never unmount. When the source pages older history in (digital-human transcripts), the window follows the rows it showed and the view stays on the same row; at the top of everything loaded it asks the source for more (`onLoadEarlier`). | `useHistoryWindow.ts` |
| Following new content | ResizeObserver re-pins to the end while following; upward intent (wheel, touch, keys, scrollbar grab) detaches immediately; growth the reader just caused (a click or key inside) is left in place unless a turn is live | `useStickToBottom.ts` |
| Keeping the view still when content above it changes size | The follower's own anchor: the first element starting inside the view keeps its position. Native `overflow-anchor` is off — the browser's anchor choice skips contained rows and can land on the live area at the end | `useStickToBottom.ts` |
| Restoring a reading position | Message id + offset, not scrollTop | `position.ts` |

Do not reintroduce a virtualizer for transcripts. Fixed-height lists
(conversation list, spreadsheet viewers) are a different case and use one.

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
