# Turn Gate — Delivery and Exclusivity

## Responsibility and boundary

The gate owns a bounded inbox and an exclusive turn reservation per session key.
It has no conversation, team, engine, or transport dependencies. Apps and services
provide their own adapters through `TurnGateHooks`; both layers depend downward
on this platform module. There is one delivery algorithm, even when each surface
has its own gate instance and session key space.

Permission-aware delivery changes this module's public contract: a reservation is
an exclusivity primitive, not evidence of sender authority. A user-started turn
may accept messages from another surface only when the caller supplies equal,
known permission identities. No caller should reimplement that comparison.

## Public contract

- `dispatch(key, job)` resolves on acceptance, not turn completion. Rejecting means
  the job was not accepted. The caller later reports completion through `release`
  and `drain`.
- `isBusy(key)` covers dispatch activity and running work. It must not go idle
  while an engine still owns an accepted continuation.
- `getJobIdentity(job)` and `getActiveIdentity(key)` return opaque identities.
  Undefined is unknown, never equal to another undefined identity.
- `mergeJobs(jobs)` preserves original message order and every message's provenance
  inside one model input. Without this hook, jobs remain individual.
- `refreshJob(job)` optionally revalidates a deferred runtime notice before its
  identity is compared or its group selected. Originals retain their arrival slots,
  including when their authority changes; newly equal coalescing keys keep the
  latest entry. Undefined cancels the notice. A thrown refresh leaves unknown
  authority and prevents dispatch until revalidation succeeds. Human inputs without
  a refresh callback retain their captured sender identity.
- `deliverMidTurn(key, job)` synchronously accepts the entire merged job or returns
  false. The adapter verifies engine liveness next to its send, with no intervening
  await. A successful handoff transfers responsibility for final-reply races to
  the engine; it must consume the input in the active turn or its immediate continuation.
- `notifyReady(key)` reports that a consumer can now listen. It releases compatible
  startup messages immediately, without waiting for that turn to finish.
- `tryDeliverLive(key, job)` offers caller-owned durable context without taking queue
  ownership. False leaves the caller's spool unchanged. True may also consume queued
  compatible messages that precede it. It never starts a turn.
- `bufferedJobs(key)` returns a read-only job-only snapshot from that key's
  current mailbox, excluding exclusive callbacks and already dispatched work.
  It changes no scheduling state and creates no second queue. Receivers use it
  to project their own pending-input identities when transferring context.
- `bufferedCount` is the authority for capacity checks; consumers must not maintain
  an asynchronously incremented mirror of mailbox depth.
- `park(key)` is for a person stopping the work: what waits for the key, and
  what is put back later, neither joins a turn nor starts one — not the turn being
  stopped, and not one when it ends. The hold stands even with nothing waiting,
  because input taken back from the stopped turn may arrive afterwards. The next
  accepted `deliver` (a skipped restart attempt is not accepted), `notifyReady` or
  `runExclusive` for that key releases it into the ordinary algorithm below;
  `discard` clears it. A held key keeps no recheck timer. Internal stops do not park.
- `putBack(key, jobs)` returns jobs taken back from a stopped turn, ahead of the
  waiting ones and never refused by the capacity bound. Several put-backs during
  one hold keep the order they were called in. They wait with the key
  while it is held; if an arrival after the stop already released it, they join
  the ordinary flow at once.
- `canOpenTurn(job)` (optional) marks jobs that may join a running turn or ride in
  a batch that opens one, but never open a turn themselves — for input whose
  record the target already holds and whose opener would be written twice.

## Delivery order

1. An idle, empty target starts immediately. Reservation happens before calling any
   asynchronous dispatch code, closing the two-concurrent-starts window.
2. Busy targets accept all queued jobs with the active identity, in arrival order,
   together with the new compatible job. Jobs with other identities remain queued.
   The turn need not have been started by this gate.
3. A target still starting retains its messages until `notifyReady`. The periodic
   backstop also checks for readiness and idle transitions if a lifecycle signal is lost.
4. Once idle, the earliest waiting permission group starts as one turn. Later jobs
   of the same known identity join it; other groups keep their relative first-arrival
   order. Unknown-identity jobs always run individually. A group `canOpenTurn`
   refuses is passed over and keeps waiting.
5. A refused live handoff keeps its entire batch. If the busy probe already cleared,
   idle dispatch is attempted immediately; otherwise turn completion or the backstop
   handles it.

`runExclusive` callbacks share this exact inbox and reservation. They are FIFO
barriers: neither batching nor live delivery may move a job across one. A callback
releases and drains on both success and failure. Unlike an ordinary message, a
callback may own a result promise and cannot be folded into another turn's input.

## Coalescing, bounds, and failure

`getCoalescingKey(job)` replaces an older waiting job only within the same known
permission identity and the same barrier segment. The replacement takes its actual
arrival position. `onDiscard(oldJob, 'superseded')` lets callers settle bookkeeping.
This is appropriate for repeated periodic checks and one member's latest completion
notice, never for independent human messages.

A full inbox rejects the new entry with `TurnGateCapacityError`; it never sheds
already accepted work. Callers can report explicit backpressure and retain durable
input for retry. A failed initial dispatch rejects its caller and releases its slot.
A failed buffered dispatch restores the original batch ahead of later arrivals and
retries through the backstop. `retryDispatch` may identify permanent admission
failures; `onDiscard` then settles their callers instead of retrying forever.
Explicit `discard` is the only hard cancellation path:
it reports every removed job, rejects queued exclusive callers, and clears timers. Dispatches still awaiting acceptance are marked cancelled too;
a later rejection cannot restore their old batch or restart a stopped task.
`discardJobs` cancels selected queued senders without freeing a running turn or
disturbing the remaining messages.

`onBusy: 'skip'` remains for attempts to restart the same run (scheduled/manual run
semantics), not for messages or new events addressed to a running AI.

## Completion and recovery

`release` and `drain` deliberately remain separate. Team completion releases the
reservation before checking whether an epoch has been sealed; a sealed epoch must
not restart its mailbox. Other callers normally invoke both.

An optional `reservationTtlMs` reclaims a held reservation only when `isBusy` is
false. Only an owner that knows its maximum legitimate startup delay may enable it;
a live turn is never reclaimed. Interop instead uses its richer phantom check: no
live session and no in-flight dispatch. `discard` likewise retains a reservation
while its busy probe reports real activity.

Reservations have internal generation tokens. Dispatch failures, exclusive callback
completion and watchdog recovery can release only their own generation; a retired
operation cannot free its replacement. Pending dispatch attempts are tracked until
their acceptance promise settles, including retired attempts, so explicit discard
can cancel all of them without resurrecting older work.

A timer exists only while there is queued work or an explicitly enabled reservation
watchdog. Timers are unref'ed and cleared when their state empties. Logs record
accepted delivery, start, buffering reason, capacity rejection and recovery without
message content. The gate does not run on token or tool-event paths.
