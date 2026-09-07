# Turn Gate — Design Decisions

> Module: `src/main/platform/turn-gate/`
> Extracted from: `apps/runtime/team/message-bus.ts` (Cross-Conversation Interop)
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
type DeliverDisposition = 'dispatched' | 'mid_turn' | 'buffered' | 'skipped'

interface TurnGateHooks<TJob> {
  dispatch(sessionKey: string, job: TJob): Promise<void>  // resolves on ACCEPT, not completion
  isBusy(sessionKey: string): boolean
  deliverMidTurn?(sessionKey: string, job: TJob): boolean  // optional; see §8
}

interface TurnGateOptions<TJob> {
  bufferCap?: number          // default 128
  recheckMs?: number          // default 3000
  reservationTtlMs?: number   // opt-in, no default — see §7
  describeJob?: (job: TJob) => string   // log lines only
}

interface TurnGate<TJob> {
  deliver(sessionKey, job, onBusy?): Promise<DeliverDisposition>
  runExclusive<T>(sessionKey, run: () => Promise<T>): Promise<T>
  release(sessionKey): void          // release the slot WITHOUT draining
  drain(sessionKey): void            // attempt one buffered dispatch
  isOccupied(sessionKey): boolean    // running turn OR held reservation
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

## 7. The reservation cannot be permanent (`reservationTtlMs`, `isOccupied`)

A reservation is cleared by one thing: the caller reporting its turn ended. That
report travels through caller code, so it can be lost — a throw on the
completion path, a turn that ends somewhere the caller never watches. What
followed was a session locked for the life of the process, and locked silently:
mail only queued, the recheck timer re-armed forever without draining, and the
caller's own busy probe still read idle, so every surface built on that probe
said "nothing is happening" at the exact moment nothing could happen.

Two rules close it, and neither is optional on its own.

**The gate reclaims a reservation it has held past `reservationTtlMs`** — but
only while `hooks.isBusy` is false. A turn that is actually streaming keeps its
slot and re-arms the watchdog; freeing it would start a second turn on one
session, which is the corruption the lock exists to prevent (see the team
module's "One turn per session"). So the TTL only has to exceed the longest
legitimate gap between reserving and the busy probe turning true — a dispatch in
flight, a turn queued behind a concurrency limit.

**It is opt-in and has no default**, which is not a convenience choice. Only the
caller knows that bound, and only the caller knows whether `isBusy` is the whole
truth about its own liveness. Cross-Conversation Interop's is not: it recovers
phantom slots itself, lazily, on the far stricter test "no live V2 session AND
nothing of ours dispatching" — a session that exists but sits idle between turns
reads `isBusy: false` here and must NOT be reclaimed. A default would have armed
a second, blinder reclaimer inside a module that had already written down why it
refuses one, and the two would have disagreed about which slots are phantoms.
Give this option only to a caller whose `isBusy` is the whole answer.

**`discard` obeys the same streaming exception.** A hard reset drops the mail
and its timers, but a slot whose turn is still streaming is kept, not freed —
freeing it would start a second turn on a session still producing. The kept
slot is released by that turn's own completion report, which the caller must
keep firing even for a session it is tearing down (the team kernel's
`completeTurn` releases *before* its sealed-epoch guard for exactly this
reason), with the watchdog as the backstop for a report that never comes.

**One residual race is accepted rather than closed.** A reservation carries no
generational identity, so a turn-end report arriving *after* the watchdog
reclaimed its slot would release whatever reservation now holds that key. No
current caller can emit a report that late: the team kernel bounds every turn
with its own timeout and sets the TTL to twice it, so the completion chain has
settled — and released — long before the watchdog fires; a reclaimed slot is
one whose report was lost, not delayed. Closing it for real means handles or
generation tokens on the public surface, a price that buys protection only
against a report later than double the turn timeout.

**`isOccupied` is public** so a caller showing a session's state to a person
reads the gate's answer, not its own busy probe. The probe answers "is a turn
streaming"; the gate answers "can this session take a turn", and only the second
one is what a status light means. Keeping them as two independent answers is
what let a stuck session render as idle.

## 8. Queueing is not the only way to be second (`deliverMidTurn`)

A mailbox answers "the session is taken" with "then wait". For a job that is
*about* the work already running — a correction, a cancellation, a fact that
makes the current task pointless — waiting is the wrong answer twice over: the
target keeps going, and the moment it stops is the moment the mail lands, which
is also the moment the sender is finally told it stopped. Both sides then act on
a picture one step out of date. So a caller may offer `deliverMidTurn`, and the
gate hands the job to the turn that is running instead of behind it.

Optional on purpose. It cannot be implemented here: only the caller knows what
"add this to a running turn" means for its own session layer, and for some
callers there is no such thing. Absent → the gate behaves exactly as before.

The gate refuses to call it unless four things hold, and each rules out a
different way mid-turn delivery would be wrong rather than merely early:

- **The running turn is one this gate dispatched** (`reserved`). A session can
  be busy with a turn the gate never saw — its owner typing into the same
  conversation. Folding someone else's job into that turn derails a private
  exchange, and runs it with whatever that turn was permitted to do, which is
  not what this sender was granted.
- **`isBusy` says a turn is under way** — necessary, and NOT sufficient. That
  probe is deliberately wide, because it is also the watchdog's input (§7): a
  narrow reading there would free a slot whose dispatch is merely in flight and
  let the next delivery start a second turn on it. Being wide, it can read true
  for a turn that is queued but not yet begun, and it can still read true in the
  moment after the engine emits a result and before the session is torn down —
  a window in which sent text goes nowhere.
- **The mailbox is empty.** Otherwise this job overtakes ones already queued for
  the same session. Out of order is worse than late: a later message earns its
  keep by superseding an earlier one, which only works if it is read second.
- **`onBusy` is `buffer`.** A `skip` caller has decided a missed round is better
  than a stacked one; that judgment is about the target being busy at all, and
  mid-turn delivery does not change it.

**The hook must verify liveness itself, immediately before it hands anything
over, and answer false when it cannot.** The four conditions narrow the field;
only the hook — standing next to the send with nothing awaited in between — can
close the last gap, and a gate-side check would sit *earlier* in the same
synchronous chain and buy nothing. This obligation is the contract, not an
implementation detail: a hook that trusts `isBusy` alone will one day report a
message delivered that reached no one, which is strictly worse than queueing it
late.

The hook must also be synchronous, and must answer false rather than throw — a
throw is caught and treated as false. Anything awaited between reading "a turn
is under way" and acting on it lets the turn end underneath; the mailbox is
always available, so a false negative costs latency and never a job. It takes no
slot and frees none: the turn it joined still holds the reservation and still
completes on its own terms.
