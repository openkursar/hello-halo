# Chat store — one page over two conversation stores

`ChatView` is the only chat page. A conversation on it lives in one of two
places, and the page must not know which:

| | space conversation | digital-human conversation |
|---|---|---|
| stored by | `conversation.service` (JSON + thoughts file) | the digital human's run JSONL (`apps/runtime/session-store`) |
| id | uuid | `app-chat:{appId}` (default session) or `app-chat:{appId}:local:direct:{uuid}` |
| read | whole, thoughts loaded on demand | newest page, older pages and thoughts on demand (`shared/types/transcript`) |
| sent through | `api.sendMessage` | `api.appChatSend` |

What differs is exactly a set of verbs, and they live behind one interface.

## Backends (`backend/`)

`backendFor(conversationId)` is the only place an id is turned into a decision
about where a conversation lives. Store actions (`sendMessage`, `stopGeneration`,
`injectMessage`, `loadMessageThoughts`, `clearConversation`, the turn-complete
handler, ...) resolve a backend and speak `ChatBackend`
(`open / refresh / send / stop / inject / settleTurn / loadThoughts /
loadEarlier / loadThrough / clear?`). Do not read `isAppChatKey`/prefixes
anywhere else in the store; use `conversationKind` / `digitalHumanAppId`
(`backend/kind.ts`, backed by `shared/apps/im-keys`).

Three kinds, three backends:

- `space` — `backend/space.ts`: behavior the store always had, gathered.
- `digital-human` — `backend/digital-human.ts`: the default and local sessions the
  user opens on the board. Enter `conversationCache` under their `app-chat:` key.
- `virtual` — `backend/virtual.ts`: every other `app-chat:` key (IM, HTTP, team
  member). Only their live turn is tracked here; the transcript belongs to the
  view that shows it (`ImChatView`, team chat). `settleTurn` retires the streamed
  state and nothing else.

Adding a conversation store means adding a backend, not a branch in a slice.

Outside `stores/`, import only from `chat.store` (it re-exports the selectors,
`conversationKind`, `digitalHumanAppId` and the `ChatState` type); `chat/*` files
are the store's internals.

`isLoadingConversation` belongs to the space backend. `ChatView` shows any
conversation on screen as loading while it is neither cached nor failed; a second
writer of the shared flag ended one backend's load while the other's was still
running.

## The conversation on screen

A space has two pointers: `currentConversationId` (the regular conversation last
opened — kept while a digital human is selected, so switching back lands there)
and `selectedAppChat`. `selectActiveConversationId` (`active.ts`) is what the page
shows. Anything that answers "which conversation is the user looking at" — the
composer, header model, header title, touched files, search scope — reads it. Reading
`currentConversationId` directly answers for the hidden conversation. The header
model control follows the same rule (`useActiveModelTarget`): a digital human's
model is read from its settings and edited there; the control never writes a
conversation while one is on screen.

The mounted `ChatView` reports `visibleConversationId` through
`setVisibleConversation`, clearing it on unmount or when the mobile canvas covers
it. A selected id alone does not mean the user is viewing it. Completion tracking
and foreground reads share `selectViewedConversationId`: the reported id must
match the active selection, and the document must be visible and focused.
Mounting, switching conversation and foregrounding read only that conversation's
unseen completion; plain errors remain pending until explicitly opened.

## Turn lifecycle (digital human)

1. `send`: session turn state and the optimistic bubble (`pending-*` id,
   `clientKey`) land in **one** `set`. A refusal withdraws the bubble and resolves
   `false` so the composer hands the draft back.
2. `agent:*` events stream into `sessions` exactly as for a space conversation.
3. `agent:complete` → `settleTurn`: read the newest page, `reconcileTranscript`
   it into the cached conversation and end the streamed turn **in the same
   `set`** — the reply never disappears and reappears. `turnId` (captured before
   the read) guards against a turn that started meanwhile.
4. While a turn is in flight the reader already lists its partial reply, which the
   streaming section is drawing; `withPage` holds back trailing replies not yet
   shown until the turn settles, or the same text would appear twice.

`reconcileTranscript` keeps unchanged rows as the same objects, gives a persisted
message the `clientKey` of the pending bubble it answers (React row identity,
`utils/message-row-key`), keeps thoughts already loaded, and keeps older pages the
reader paged in. Row keys, not ids or indexes, key `MessageList` rows — a prepended
page must not rebuild the rows below it (`transcript/useHistoryWindow` follows the
rows it was showing when the list grows at the front).

## Which conversations stream in full

Main sends every agent event only for conversations a client retains
(`api.retainConversationDetail`, rule in `shared/agent-event-visibility`); all
others arrive as status events (turn start, complete, error, question, goal).
`detail-retention.ts` owns the store's side:

- Every view rendering a session's live detail retains its conversation with
  `hooks/useConversationDetail` (`ChatView`, `ImChatView`, team chat).
- A turn sent from this window (`sendMessage`, `continueAfterInterrupt`) is held
  until `agent:complete` has settled it (unless a newer turn started meanwhile),
  `agent:error`, or a refused send — the reply keeps streaming while the user
  looks elsewhere.
- Detail handlers ignore a conversation that is neither retained nor already in
  `sessions`, so background digital humans and team members never grow state
  here.

Opening a conversation whose turn another client or an autonomous trigger
started shows its text from the moment it was retained; the settled transcript
replaces it when the turn completes.

## Cache, recovery, reset

- `conversationCache` is bounded by count (`CONVERSATION_CACHE_SIZE`) and by
  estimated heap (`CONVERSATION_CACHE_BYTES`: text, inline images, inline
  thoughts), oldest-cached-first via `backend/cache.ts`. Thoughts read on demand
  stay in their message but share one budget (`LOADED_THOUGHTS_BYTES`,
  `cacheLoadedThoughts`); past it the oldest are set back to not-loaded, never
  the one just opened. Under critical memory pressure (`api.onMemoryPressure`,
  wired in `App.tsx`) `shedBackgroundDetail` keeps only the pinned conversations
  below, with on-demand thoughts and finished-turn steps only for the one on
  screen. The cache never evicts the conversation on screen, either
  pointer of the current space, any space's selected digital human, or one with a
  generating session. Whatever conversation is on screen but uncached anyway —
  evicted, or landed on by a path that only moved a pointer (the next
  conversation after a delete, the regular conversation behind a digital human)
  — `ChatView` reads in (`openConversation`) and shows as loading until it lands.
  Both backends deduplicate concurrent reads of one conversation, and a failed
  read is recorded in `conversationLoadErrors` (shown with a retry), never
  retried in a loop.
- A digital-human turn that ends while its conversation is not cached is not read
  (nothing shows it); one whose history was cleared after the read is not merged.
- Opening a cached conversation shows it at once and merges a background re-read;
  `open` also recovers a turn already running (thoughts, pending question, retry).
  A space conversation's open also warms its engine session for a first message;
  a view that only reports on a conversation it does not show (the changes
  view's review card, `hooks/useReviewProgress`) opens with `{ warm: false }`.
- Reconnect (`useWsRecovery` in `ChatView`) and the foreground-resume path in
  `App.tsx` both end in `handleAgentComplete` for a session the backend says is
  over; a digital-human id resolves its space from the cached conversation.
- `resetSpace` drops the space's cached digital-human conversations too;
  `forgetConversation` drops one conversation's every trace (cache, session, init
  info, draft, selection).

## Turn lifecycle (space)

Both backends merge reads through `reconcileTranscript`. A space send shows a
`pending-*` bubble (`createPendingUserMessage`); `settleTurn` re-reads from the
last message the user sent (`rereadAnchor`: everything earlier belongs to
finished turns and no longer changes) with `getConversation(…, { fromMessageId })`,
joins the cut read onto the held messages (`joinFromAnchor`; a cut point no
longer held means the conversation changed, and it is read whole), and
reconciles — unchanged rows keep their objects and loaded thoughts, the bubble's
row passes to its persisted twin, and a bubble of a turn sent meanwhile stays.
`refresh` reconciles too, keeping unconfirmed bubbles while a turn runs.

## Naming

`stores/chat/backend/` is the chat page's data driver (open, send, stop, inject,
continue, clear). It is named apart from the main-process `ConversationSource`
in `services/conversation-interop` (the cross-conversation directory) on
purpose: the two answer different questions and must not be read as one.

## Not here

Space-conversation storage, the transcript reader (`shared/transcript`,
`apps/runtime/session-store`), and the scroll primitives
(`components/chat/transcript/DESIGN.md`).
