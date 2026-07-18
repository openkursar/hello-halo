# runtime/federation/log — Unified Feed Log Substrate

The **bare, location-independent core** shared by every cross-node plane
(message / activity / history) and by the blackboard replication layer. It turns
the fire-and-forget control path into an **effectively-once** channel and makes
history load incremental — the three production symptoms (dropped frames + 2h
hangs, full-transcript re-pulls, post-restart silent drops) share one root cause:
there was no *persistent, sequenced log* as the sync unit. This module is that
unit.

> Design source of truth: `local_docs/features/数字团队/技术/数字团队-统一Feed底座-技术方案.md`.
> This module implements that doc's **bare core** (Step 1 substrate). It holds
> **no quorum, term, or election** logic — those stay in `authority/*`, which
> becomes another consumer of this core.

## The model

Every cross-node datum is one entry in a **per-author, append-only, immutable
feed**. Single-writer by construction (only the author node writes its own
feed), so there is never a conflict — reliability is *delivery + cursor sync*,
not consensus, and ordering is *causal*, not total.

```
FeedId = { officeId, author, kind }        kind ∈ 'ctrl' | 'act' | 'session:<key>'
entry  = { seq, hlc, fid, type, payload, ts }
         seq  — per-(office,feed) monotonic, persisted (survives restart)
         hlc  — hybrid logical clock, lexicographically sortable
         fid  — cross-restart-unique idempotency key
```

## Files

| File | Role |
|---|---|
| `hlc.ts` | Hybrid Logical Clock. One comparable value that tracks physical time but advances monotonically to respect causality: `a after b ⇒ hlc(a) > hlc(b)`, while `hlc.pt` stays within bounded drift of wall time. Fixed-width hex encoding ⇒ string compare == numeric compare. Replaces the broken "wall-primary + logical-secondary" ordering. |
| `durable-log.ts` | `DurableFeedLog` — the write end of a node's own feeds: allocate the next seq (anchored to the retention floor so a fully-pruned feed never reuses seq 1), stamp HLC + fid, persist. Seeds/merges the office clock so a restart never regresses it. |
| `sync-engine.ts` | `FeedProducer` (author side: windowed, ack-driven delivery + nack/retransmit resend) and `FeedConsumer` (reader side: in-order apply with fid dedup, gap buffering, cumulative ack). Transport-agnostic — both take a `send` closure. |
| `feed-service.ts` | `FeedService` — per-office assembly facade composing the log + producer + consumer + `FeedStore` cursors, owning the retransmit-backstop timer and resolving that a consumer's control frames route to the feed's **author**. The seam domain handlers (message/activity/history) plug into. |
| `types.ts` | `FeedId`/`FeedEntry` and the four sync frames (`feed-subscribe` / `feed-entries` / `feed-ack` / `feed-nack`) — one mechanism serving Live push, reconnect gap-fill, history load, and late-join backfill alike. |

Persistence lives one tier down in `apps/federation` (`FeedStore` +
`app_federation` migration v6: `feed_log` / `feed_peer_cursor` /
`feed_local_cursor` / `feed_cache` / `feed_meta`).

## Reliability contract

- **Effectively-once**: append is durable *before* send; a peer's cumulative ack
  advances the delivery watermark; anything above the ack is resent on nack or
  on the retransmit backstop; the consumer dedups by fid and by seq. A dropped
  frame is redelivered, never lost.
- **Flow control**: only a *forward* ack releases the next window — a stalled
  peer (e.g. a deferring apply) does not live-lock the producer; the rate-limited
  backstop owns resends for a stuck-but-behind peer.
- **Ordered apply**: the consumer applies strictly from `cursor+1`; a throwing
  `apply` defers the rest (the entry stays buffered and retries).
- **Bounded retention**: on each tick the producer prunes every served feed below
  the *lowest* delivery watermark across its live subscribers (`FeedProducer.prune`
  → `DurableFeedLog.truncate`). It never trims below a subscriber's cursor, so a
  lagging peer is never left with an unfillable gap; seq allocation is anchored to
  the retention floor, so a fully-pruned feed never reuses seq 1. A fully-acked
  outbox shrinks — no unbounded `feed_log` growth.
- **Give-up (ctrl plane)**: a directed wake that its target never acks is not
  retransmitted forever silently. `ctrl-feed` tracks each published wake and
  resolves it either *delivered* (target acked past its seq) or *undeliverable*
  after the give-up deadline on the tick — the deadline is the SOLE arbiter: a
  transient presence-offline (WAN tunnel flap) keeps the wake *pending* in the
  outbox, which redelivers on reconnect. `onUndeliverable` lets the authority
  resolve the sender's completion waiter as `undelivered`, so "the message never
  arrived" is known in bounded time instead of hanging on the long completion
  backstop. A *delivered* wake is never re-reported (its completion is awaited
  separately); turn-complete entries are not tracked (their author does not wait
  on delivery).

## Layer position

```
runtime/federation/log
  ├── may import: apps/federation (FeedStore), ../protocol-m2 (fid dedup), ../types (NodeId)
  └── MUST NOT import: http/*, bootstrap, services/*, the team kernel
```

Transport and domain handlers are **injected** (`sendToPeer`, `apply`), so the
manager wires this to the link without the module importing either — the same
additive-not-rewrite discipline the rest of `runtime/federation` follows.

## Status

The substrate is the **single** transport for the control plane: `ctrl-feed`
carries every wake / turn-complete over this log (no raw fire-and-forget path,
no capability gate). Retention pruning and ctrl-plane give-up are wired (above).
The session plane (`../session-feed.ts`) is the second consumer: per-session
transcript feeds proactively replicated to every office node (multi-replica,
never pruned), with the `feed-advertise` frame as its discovery half and a
mirror-backed producer so the office authority serves feeds authored elsewhere.
Activity relay still uses its own path — migrating it onto this substrate is
later work, gated by the `tests/decentralized/` cluster regression. The
consensus paths (`authority/*`) remain a separate consumer of the bare core.

## Tests

`tests/unit/apps/runtime/federation/log/*` (hlc, durable-log, sync-engine,
feed-service) + `tests/unit/apps/federation/feed-store.test.ts`. The HLC suite
includes the causality regression (a reply on a slow clock must still sort after
the message it replies to); the sync-engine suite exercises loss/nack/retransmit/
dedup/out-of-order/deferred-apply; feed-service runs two services end-to-end
through a drop-injecting bus over a real store.
