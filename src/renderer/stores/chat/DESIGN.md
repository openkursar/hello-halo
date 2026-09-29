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

`isLoadingConversation` belongs to the space backend. A digital-human conversation
reads as loading while it is neither cached nor failed; a second writer of the
shared flag ended one backend's load while the other's was still running.

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

## Cache, recovery, reset

- `conversationCache` is bounded (`CONVERSATION_CACHE_SIZE`), oldest-cached-first
  via `backend/cache.ts`, which never evicts the conversation on screen, either
  pointer of the current space, any space's selected digital human, or one with a
  generating session. If a selected digital-human conversation is uncached anyway,
  `ChatView` reads it in again (`openConversation`).
- A digital-human turn that ends while its conversation is not cached is not read
  (nothing shows it); one whose history was cleared after the read is not merged.
- Opening a cached conversation shows it at once and merges a background re-read;
  `open` also recovers a turn already running (thoughts, pending question, retry).
- Reconnect (`useWsRecovery` in `ChatView`) and the foreground-resume path in
  `App.tsx` both end in `handleAgentComplete` for a session the backend says is
  over; a digital-human id resolves its space from the cached conversation.
- `resetSpace` drops the space's cached digital-human conversations too;
  `forgetConversation` drops one conversation's every trace (cache, session, init
  info, draft, selection).

## Known asymmetry

Optimistic-message reconciliation (`backend/reconcile.ts`) is used only by the
digital-human backend; the space backend keeps its own send-to-settle handling.
Users see the same behavior, but the two paths are separate implementations.
The next time the space send flow is changed, move it onto `reconcileTranscript`
rather than opening a change for that alone.

## Naming

`stores/chat/backend/` is the chat page's data driver (open, send, stop, inject,
continue, clear). It is named apart from the main-process `ConversationSource`
in `services/conversation-interop` (the cross-conversation directory) on
purpose: the two answer different questions and must not be read as one.

## Not here

Space-conversation storage, the transcript reader (`shared/transcript`,
`apps/runtime/session-store`), and the scroll primitives
(`components/chat/transcript/DESIGN.md`).
