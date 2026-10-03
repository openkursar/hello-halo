# Performance and Scale Rules

> Read before touching any hot path: streaming render, IPC/WS event emitters, file watching,
> Content Canvas viewers, engine sessions, crash/recovery, team/federation sync, or any cache.
>
> These rules came out of a measured audit (September 2026). Each one exists because its
> violation was found in the code, reproduced, and cost real memory, CPU or data. Rules marked
> ⚙ are enforced by guard tests under `tests/unit/architecture/` — if a guard fails, fix the
> code, not the guard. Adding an allowlist entry needs a reason a reviewer would accept.

## 0. Five failure patterns (think in these, not in rule numbers)

1. **×N without filtering** — data pushed because it exists, not because a receiver needs it.
   Fix shape: subscription + visibility filter + serialize once per frame.
2. **Event → full reload** — an event triggers a whole-table refetch or whole-file re-read.
   Fix shape: events carry the delta; every read API takes `limit`/`since`.
3. **Cost ∝ accumulated size, not increment** — re-processing the whole text/document/tree on
   every delta. Fix shape: process only the tail or the diff.
4. **Create without destroy / bounds that are bypassed** — per-space/per-office/per-tab
   resources and module-level caches with no release path or no bound.
   Fix shape: the PR that creates a resource names its release call site; caches have a bound
   and an eviction policy.
5. **Implicit lifecycle** — behavior that relies on hand-written resets instead of a contract.
   Fix shape: explicit contracts (React `key`, disposable stores, budgets, recovery state machine)
   plus a guard test.

## 1. Events and transport

- ⚙ Streaming agent events reach a client only for conversations it declared. One rule for IPC
  and WS: `shared/agent-event-visibility`. Views that render live detail hold
  `retainConversationDetail` exactly while mounted; the chat store never creates session state
  from detail events for a conversation nobody retains. `ipc/*.ts` forwards, never orchestrates.
- ⚙ Delta events carry the increment only; accumulated content may travel once, on the
  completing event (`agent:thought-delta` carries `delta`, never `content`).
- ⚙ File-system events leave main only as `artifact:changed-batch` (per flush, per space,
  ≤1,000 changes) and `artifact:tree-update`. A consumer with per-file state treats
  `resync: true` as "every file may have changed". Bursts over the limit still reach per-path
  subscribers (automation triggers) unresolved; only derived state resyncs.
- ⚙ `team:updated` names what changed (`changed`); listeners reload only that. Replication
  reaches the renderer as row deltas (`team:blackboard`). Omitting the hint means "structural
  change" and is reserved for lifecycle events.
- A status push equal to the last one sent is not sent; a renderer store receiving an unchanged
  state returns the same object.
- A frame sent to several clients is serialized once in the transport layer. A backed-up client
  may lose only frames marked droppable (live `*-delta` stream frames, re-announced discovery);
  the reply text, tool results, completion, replication, ctrl, roster and presence are never
  dropped. Any new broadcast states its receiver set and its bytes/s at N = 100 nodes.

### Federation: who receives what

- A node's inbound federation traffic is what it owns, what it shows, and a digest of the rest —
  never proportional to office size: streams by subscription, run state as versioned
  `member-status` deltas, wakes on the node's own `ctrl:<node>` feed, and transcripts replicated
  lazily behind a `feed-digest`. Subscriptions are soft state, re-declared after every (re)join,
  reconnect and election.
- ⚙ Federation speaks one protocol. There is no capability negotiation, only a version gate:
  `FEDERATION_PROTOCOL_VERSION` (`src/shared/federation/protocol-version.ts`), checked in
  `isSameProtocol` (`protocol-m2.ts`), and every node must match it. A breaking wire or
  semantic change ships by bumping it. The conditions for revisiting this are in the
  "Compatibility policy" section of `apps/runtime/federation/DESIGN.md`.
- Traffic bounds are asserted during development by the in-process simulation
  (`tests/unit/apps/runtime/federation/_sim/traffic-bounds.sim.test.ts`, seconds); the
  real-process cluster suites are release-time confirmation, run with `--only` for targeted
  checks and in full once before a release.
- History that is not local is not proof of absence: a transcript that is not local is fetched on
  demand and shown as "unavailable right now", never as "this member said nothing". History is
  guaranteed only while the office authority is online.
- ⚙ Plane names, order and bounds come from `src/shared/federation/planes.json`; the gateway's
  Go plane list is generated from it and no queue declares its own capacities.

## 2. Reads, persistence, and bounds

- ⚙ Main never reads a user data file (JSONL transcript, log, feed) whole. Readers stream or
  seek, take `limit`/`before`/`since`, and `platform/file-cache` refuses an entry above its
  weight budget.
- Every read API that can grow with the user's data takes a limit and returns `truncated`.
  `artifact:*` reads are one level or top-N; the renderer never fetches, filters or sorts a whole
  file list (⚙ no unbounded sort inside `useMemo` on file surfaces).
- A re-read after a turn transfers only what the turn can have changed
  (`getConversation(…, { fromMessageId })`) and merges with `reconcileTranscript`.
- ⚙ A replicated/synced feed batch applies inside one store transaction; its ack follows the
  commit (ctrl plane excepted: per-entry cursor persistence is safer for wake side effects).
- Every office/space-level table and cache has a trim path whose caller is not its writer.
  The team replication log is the deliberate exception: it is not pruned yet (about 1 KB per
  entry), and the version gate now makes pruning safe when it is needed (floor in federation
  DESIGN). Its size is reported on the office health line so growth stays visible.
- A per-space/per-office/per-tab resource ships with its owner and its release call site in the
  same change. Watchers are reference-counted by holder; client-facing caches have an explicit
  release plus an LRU bound; memory-heavy derived state (path index) is built on demand and
  dropped when idle.
- ⚙ Module-level caches have a bound and a stated eviction policy. Code highlighting goes
  through `lib/shiki-code-plugin.ts`; `@streamdown/code` is not used.
- Renderer caches that hold user content are bounded by estimated bytes, not only entry count.
  Content that can be re-read from disk has its own budget and is dropped first under pressure.
- The desktop renderer receives stored binary content (images) as `halo-file://` URLs, never as
  base64 inside conversation payloads.

## 3. Rendering

- ⚙ Streaming render cost follows the delta: a `mode="streaming"` renderer mends and lexes only
  the open tail (`lib/streaming-markdown.ts`) and never highlights code while streaming (product
  rule: fences are monochrome until the reply finishes). Every other `<Streamdown>` is static.
  New Streamdown plugins are measured on the 10K/40K streaming curve before merge.
- ⚙ No component subscribes to a whole chat session object; high-frequency fields are read by the
  smallest component that renders them.
- Tool output is truncated before it reaches a renderer (collapsed by lines and characters,
  expanded content chunked and mounted on visibility, highlighting capped).
- Transcripts keep at most `MAX_LIVE_ROWS` rows live; rows leave only as placeholders of their
  measured height (`components/chat/transcript/DESIGN.md`).
- Partial results are labelled as partial, and polling for completion stops when complete or when
  nobody is looking.

## 4. Content Canvas (full spec: `src/renderer/components/canvas/DESIGN.md`)

- ⚙ One viewer instance per tab (`key={tab.id}`); no effect keyed on tab identity inside a viewer.
- ⚙ Viewers get resources through `useViewerResources()` (per-tab disposable store), never import
  canvas store/state hooks, and are looked up in the viewer registry (compile-time exhaustive over
  `ContentType`; unknown types render as text).
- `TabState` is immutable; subscribe at the narrowest granularity (`useTabList`, `useActiveTab`,
  `useBrowserState(tabId)`, `useCanvasActions`).
- Content replaced from outside the editor is never undoable (`addToHistory: false`) and never
  overwrites unsaved edits — a divergence is shown to the user (load disk / keep mine).
- Budgets (`shared/constants/canvas-budget.ts`): 30 open tabs, 6 live browser views, a hidden
  content byte budget; released LRU with a notice, never unsaved edits, terminals, or AI browser
  views. `critical` memory pressure releases all hidden content and views.
- Third-party renderers: pair every `createObjectURL`/`revokeObjectURL` and listener add/remove;
  unpaired ones get a `patches/` fix.

## 5. Security boundaries found on the performance path

- ⚙ Untrusted HTML never runs in the app origin: no `allow-same-origin` on a srcdoc frame. Files
  preview in `halo-preview://` (own site, own CSP, confined to the file's directory after
  `realpath`, no dot-files, refused for the filesystem root / home / Halo data roots,
  `connect-src 'self'`); generated content without a file uses an opaque srcdoc sandbox.
- `halo-file:` stays out of the app CSP's `connect-src`/`frame-src`/`script-src`, stays an
  unprivileged scheme, and its documents are served inert (`CSP: sandbox`). A scheme that serves
  files maps opaque tokens to roots registered by main; it never derives a root from the URL.

## 6. Runtime, processes, and resources

- One engine session = one child process. Every session entry is bounded by
  `apps/runtime/session-budget` through the engine's resident limit (default 10, 5 under memory
  pressure, user-adjustable). Eviction never touches a busy session and never refuses a turn;
  an evicted session resumes on its next turn.
- ⚙ Health sampling (`services/health`) is the only producer of resource numbers; budgets,
  degradation and telemetry consume it. Memory pressure is memory-only (available RAM — on
  macOS the kernel's `memorystatus_level` — below 15 %, or the renderer above 1 GB), never
  platform or VDI detection.
- ⚙ Crash and relaunch paths never mark a session clean. Every relaunch goes through
  `services/lifecycle.relaunchApp(reason)`, which persists the reason first. Renderer recovery
  reloads at most 3 times per minute on crashes, then halts: the window is left, main and
  digital humans keep running, and the user restarts. Hangs reload but do not count as crashes.
- `window-all-closed` quits only on a real quit or when no background work holds the process.
  The main process never shows a synchronous dialog on an error path.
- Workers handle `unhandledRejection`; subscription callbacks catch and report; crash restarts
  back off exponentially and stop at a cap. Paths are normalized (`realpath`) once at the entry.
- `main.log` keeps 10 MB × 5 archives (≥ 48 h); the renderer forwards only warn/error. Hot paths
  emit no production logs (halo-logging skill §4).

## 7. Performance telemetry

- `perf.*` events consume health samples; they never measure. Numbers, booleans and enums only,
  whitelisted per event in `services/analytics`, routed to the internal Telemetry provider only
  (never GA/Baidu). The schema document and `EVENT_WHITELIST` change together (⚙).
- Crash evidence (session marker reason, pre-crash snapshot next to the minidumps) is written to
  disk before the process can lose it and reported on the next launch; minidumps are never
  uploaded.

## 8. Tests that protect these rules

- Architecture guards: `tests/unit/architecture/*.guard.test.ts` (source scans; run with the unit
  suite).
- Perf scenarios (`tests/perf/specs`, read `tests/perf/docs/measurement-practice.md` first):
  streaming link-dense and 150-line code block, long-history window, background streams, canvas
  tab switching, docx blob leak arm, 5,000-file directory expand, joiner catch-up count.
- Cluster tier (`tests/decentralized`): changes to federation broadcast/subscription must keep the
  host+30 scenario's per-joiner inbound bound.
