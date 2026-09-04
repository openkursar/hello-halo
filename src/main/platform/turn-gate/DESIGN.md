# Turn Gate — Design Decisions

> Module: `src/main/platform/turn-gate/`
> Extracted from: `apps/runtime/team/message-bus.ts` (Cross-Conversation Interop, WP1)
> Status: Implementation reference

## 1. Module Purpose

The generic "at most one turn per session key" lock, plus the FIFO mailbox that
queues whatever arrives while a session is occupied. It knows nothing about
teams, digital humans, conversations, or messages — a job is an opaque `TJob`
the caller hands back through its own `dispatch` hook. The caller alone knows
what a session key means and what busyness means for it; this module only
enforces that at most one thing may run against a given key at a time.

It exists because the reservation/mailbox mechanics are identical regardless of
*who* is turning one conversation's messages into turns — the team coordination
kernel needed it first, and Cross-Conversation Interop needs the exact same
exclusivity for ordinary (non-team) conversations. Two independent
implementations of this were rejected: it is the most heavily-tested
concurrency logic in the codebase, and a fork guarantees the two drift.

## 2. Why `platform/`, not `apps/runtime/team/` or `shared/`

Per ARCHITECTURE.md §2, dependencies flow `apps -> services -> platform ->
foundation`. The two intended callers — `apps/runtime/team` (Apps tier) and
`services/agent` (Services tier) — do not share a tier, and Apps already
depends on Services, never the reverse. A module either tier can depend on
without inverting that direction has to sit at or below Services: `platform/`
is exactly that, and is already described as generic infrastructure that must
not import `services`/`apps` (§2). `shared/` was rejected because this module
carries live runtime state (timers, in-memory maps), not types/constants.

## 3. What stayed behind in `message-bus.ts`

Roughly five-sixths of the original file: member-name resolution, topology
enforcement, the per-epoch circuit breaker, the office activity record, and
completion receipts (`pendingWaits`). None of that is generic — it is team
semantics — so it stays in the team kernel, which now calls this module for
the exclusivity mechanics instead of implementing them inline. Team behavior
is unchanged: `TeamDeliveryHooks`, `MessageBus`, and every other export of
`message-bus.ts` kept their exact signatures; only the internals moved.

## 4. Public API

```typescript
type BusyDisposition = 'buffer' | 'skip'
type DeliverDisposition = 'dispatched' | 'buffered' | 'skipped'

interface TurnGateHooks<TJob> {
  dispatch(sessionKey: string, job: TJob): Promise<void>  // resolves on ACCEPT, not completion
  isBusy(sessionKey: string): boolean
}

interface TurnGateOptions<TJob> {
  bufferCap?: number       // default 128
  recheckMs?: number       // default 3000
  describeJob?: (job: TJob) => string   // log lines only
}

interface TurnGate<TJob> {
  deliver(sessionKey, job, onBusy?): Promise<DeliverDisposition>
  runExclusive<T>(sessionKey, run: () => Promise<T>): Promise<T>
  release(sessionKey): void          // release the slot WITHOUT draining
  drain(sessionKey): void            // attempt one buffered dispatch
  hasBuffered(sessionKey): boolean
  hasAnyBuffered(match): boolean
  discard(match, reason): number     // hard reset; returns dropped job count
}

function createTurnGate<TJob>(hooks, options?): TurnGate<TJob>
```

`release` and `drain` are deliberately separate primitives, not one combined
"releaseAndDrain": the team kernel's `completeTurn` releases the slot before
it knows whether the epoch is still live, and must skip draining entirely when
it is not (a sealed epoch must not reignite a finished run). Callers that
always want both call `release` then `drain` themselves — `runExclusive`'s
internal `start()` does exactly that on every exit.

## 5. Behavior preserved verbatim from the original

- Reservation closes the async gap between `dispatch` accepting a job and the
  caller's own busy-probe turning true (two deliveries racing that window
  used to start two concurrent turns on one session).
- Mailbox is FIFO, capped at `bufferCap`, sheds the OLDEST entry on overflow,
  and fails a shed relayed run immediately rather than stranding its caller.
- A recheck timer re-arms after every buffered entry and every failed
  dispatch, closing the race where the target goes idle between the busy
  probe and the buffer push (no turn-end event will ever fire for that mail).
- `runExclusive` (formerly `runRelayedTurn`) shares the identical slot and
  mailbox as `deliver` — one queue per session, whichever kind of caller it is.
- `discard` cancels queued relayed runs with a reason instead of leaving their
  caller (possibly on another node) hanging on an hours-long backstop.

## 6. Dependencies

None beyond the Node.js `setTimeout`/`Map`/`Set` built-ins. Renderer-unsafe
only insofar as it runs in the main process; carries no Electron API.
