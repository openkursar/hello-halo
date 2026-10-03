# File watcher and artifact cache

How a space's files reach the file tree, the Canvas and the @mention menu.
Code is the source of truth; update this file in the same change as the code.

## Processes and files

```
worker process (child_process.fork)      main process                              clients (renderer IPC / remote WS)
src/worker/file-watcher/                 src/main/services/
  watcher.ts   @parcel/watcher,            watcher-host.service.ts  fork, restart,     api.onArtifactTreeUpdate
               filter, stat, coalesce        request/response, fan-out               api.onArtifactChangedBatch
  scanner.ts   readdir, ignore rules       artifact-cache.service.ts  per-space        api.listArtifactsTree / loadArtifactChildren
  path-index.ts  per-space path index        tree cache, client holds,  api.queryArtifactFiles (@ menu)
  limiter.ts   stat concurrency cap          broadcast                  api.retainArtifactSpace / releaseArtifactSpace
  index.ts     message loop                artifact.service.ts  path checks,  (renderer: services/artifact-space-holds,
                                             file ops, queryFiles             hooks/useFileMentionQuery)
```

`apps/runtime/sources/file-watcher.source.ts` subscribes to the same worker
events through `watcher-host.addFsEventsHandler` (automation file triggers).

## Invariants

1. **Paths are normalized once, at the watcher's entry.** The worker subscribes
   on the canonical root (`realpath`) and maps every OS-reported path back under
   the space's own root (`mapToWatchedRoot`). Nothing downstream ever sees a
   canonical path, so a root reached through a symlink (`/tmp` on macOS, a
   project folder linked to another disk) behaves like any other.
2. **The worker never dies from an event.** The subscription callback catches
   and reports a failed batch as `watcher-error` (the host reconciles), and the
   worker logs any `unhandledRejection` instead of exiting. A crash that still
   happens is restarted with exponential backoff (1 s doubling, 30 s max) and
   at most 5 restarts per 5 minutes; past that the worker is forked again only
   when a caller next needs it.
3. **Bursts are bounded at every hop.**
   - stat: at most 32 in flight (`MAX_CONCURRENT_STATS`), across batches.
   - worker → main: `fs-events` messages of at most 500 events; more than
     20,000 pending events for a space turn the window into an overflow: the
     rest are not stat'ed, `fs-overflow` is sent, and the events follow as
     unresolved `fs-events` (`resolved: false`, type from the OS event, no
     tree node) so per-path subscribers such as automation file triggers lose
     nothing; handlers registered `resolvedOnly` (the tree cache) skip them and
     resync instead. Past 200,000 events in one window they are only counted.
   - main → clients: per flush (500 ms debounce, 2 s max wait) and per space,
     one `artifact:tree-update` (recomputed children of affected loaded
     directories) and the changes as `artifact:changed-batch` split at 1,000;
     more than 20,000 pending changes, or lost events (overflow, watcher error,
     worker restart), are sent as `{ changes: [], resync: true }`.
   There is no per-file event channel. A consumer that keeps per-file state
   must handle `resync` by treating every file in the space as changed.
4. **Applying a batch is linear.** A loaded directory's children are indexed by
   path once per batch, removals are applied in one pass, and each directory is
   re-sorted at most once.
5. **Ignore layers** are defined in `shared/constants/ignore-patterns.ts`: the
   tree hides VCS metadata only; watching and flat listing also skip dependency
   and build directories and `.gitignore`. A change to the root `.gitignore`
   reloads the watcher's rules and rebuilds the path index.
6. **Every per-space resource has an owner and a release path.**
   - Worker watchers are reference-counted in `watcher-host`
     (`retainSpaceWatcher(spaceId, root, holder)` / `releaseSpaceWatcher`);
     the last release stops the watcher. Holders today: `artifact-cache` (the
     UI cache), `automation:<appId>` (apps/runtime file subscriptions),
     `team-trigger:<teamId>:<triggerId>` (team file triggers).
     `getWatchedSpaces()` lists holders for diagnostics.
   - The UI cache is kept per space while a client declares it shows the
     space (`artifact:retain-space` / `artifact:release-space` with a
     per-renderer client id; the renderer's `artifact-space-holds` takes a
     hold per mounted consumer and releases 5 s after the last one). At most
     3 spaces stay cached; beyond that the least recently used, unheld first,
     is evicted — this bounds what a client that never releases leaves.
   - Reconciliation (rescan of loaded directories) runs for the space a client
     shows when its window regains focus, not for every cached space.
7. **File queries never ship the listing.** Each watched space has a path
   index in the worker (`path-index.ts`): built breadth-first in the
   background (8 reads in flight, yielding every 2,000 entries), capped at
   200,000 entries (`truncated`), kept current from events, rebuilt after an
   overflow or a `.gitignore` change. `artifact:query-files(spaceId, q, limit
   ≤ 200)` ranks there (`shared/file-path-match.ts`, bounded top-k) and
   returns only the matches plus `truncated` / `indexing`. The @ menu queries
   on demand while open. `listArtifacts(spaceId, maxDepth)` is served from
   the same index (≤ 20,000 entries).
8. **The tree holds what is open.** Collapsing a folder drops its loaded
   subtree (`components/artifact/tree-index.ts` `unloadSubtree`); updates for
   a collapsed folder are ignored and it is fetched again on expand.
