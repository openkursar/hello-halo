/**
 * Turn Gate — the generic "one turn per session key" lock and its mailbox.
 *
 * Extracted from the team coordination kernel (`apps/runtime/team/message-bus.ts`),
 * which was the only caller until Cross-Conversation Interop needed the same
 * exclusivity for ordinary conversations. This module knows nothing about teams,
 * members, or envelopes — a "job" is an opaque payload the caller hands back
 * through its own dispatch hook.
 *
 * Sits in `platform/` so both `apps/runtime` and `services/agent` can depend on
 * it without either importing the other (see ARCHITECTURE.md §2 dependency
 * direction). It must stay generic infrastructure: no team/session-layer types,
 * no Electron/IPC.
 */

export type BusyDisposition = 'buffer' | 'skip'
export type DeliverDisposition = 'dispatched' | 'mid_turn' | 'buffered' | 'skipped'

export interface TurnGateHooks<TJob> {
  /** Resolves once the job is accepted/started, NOT when it finishes. */
  dispatch(sessionKey: string, job: TJob): Promise<void>
  isBusy(sessionKey: string): boolean
  /**
   * Optional. Hand a job to the turn ALREADY RUNNING on this session instead of
   * queueing it behind that turn — the difference between a target learning
   * something at its next tool call and learning it after finishing work that
   * the message may have made pointless.
   *
   * Must be synchronous, and must answer false when it could not land the job:
   * the gate falls back to the mailbox, so a false negative costs latency and
   * never a message. Absent → every busy delivery buffers, the original
   * behavior.
   *
   * **It must verify liveness itself, immediately before handing the job over.**
   * The gate's four conditions (see `deliver`) narrow the field but do not
   * guarantee a turn is listening: `isBusy` is deliberately wide — it is also
   * the watchdog's input — so it can read true for a turn that has not begun,
   * and in the moment after the engine emits a result. Only this hook, with
   * nothing awaited between its own check and its send, can close that gap; a
   * check the gate added would sit earlier in the same synchronous chain and buy
   * nothing. A hook that trusts `isBusy` alone will eventually report as
   * delivered a message that reached no one — strictly worse than queueing late.
   */
  deliverMidTurn?(sessionKey: string, job: TJob): boolean
}

export interface TurnGateOptions<TJob> {
  /** Upper bound of buffered entries per session mailbox. Default 128. */
  bufferCap?: number
  /** Backstop recheck interval after buffering, in ms. Default 3000. */
  recheckMs?: number
  /**
   * How long a reservation may be held while NOTHING is actually running before
   * the gate reclaims it. Must exceed the longest legitimate gap between
   * reserving a slot and the caller's own busy probe turning true (a dispatch in
   * flight, a turn queued behind a concurrency limit).
   *
   * OPT-IN, and there is no default on purpose. Only the caller knows that
   * bound, and only the caller knows whether `isBusy` is the whole truth about
   * its own liveness — a caller with a richer phantom test, or its own recovery
   * path, would find this one both blunter and unaware of it. Omit it and the
   * gate arms no watchdog at all.
   */
  reservationTtlMs?: number
  /** One-line description of a job, for log lines only. */
  describeJob?: (job: TJob) => string
}

export interface TurnGate<TJob> {
  /**
   * Dispatch now if the session is free; otherwise hand the job to the running
   * turn when `hooks.deliverMidTurn` can take it (`'mid_turn'`), else queue
   * behind that turn (`onBusy: 'buffer'`, the default) or drop it (`'skip'`,
   * for a wake that repeats on its own rhythm and should not pile up missed
   * rounds).
   */
  deliver(sessionKey: string, job: TJob, onBusy?: BusyDisposition): Promise<DeliverDisposition>
  /**
   * Run a callback under the same exclusivity slot as `deliver`, for a caller
   * that has already rendered its own input and just needs the session gate
   * (a federation wake landing on the member's owner). Queues behind a busy
   * session in the same mailbox as everything else.
   */
  runExclusive<T>(sessionKey: string, run: () => Promise<T>): Promise<T>
  /** Release a session's slot without draining (the caller drains explicitly, or is tearing the session down). */
  release(sessionKey: string): void
  /** Attempt one buffered dispatch for a session that may have just gone idle. No-op if busy, reserved, or empty. */
  drain(sessionKey: string): void
  /**
   * Whether this session can take a turn right now — the gate's own answer,
   * covering BOTH a running turn and a reservation whose turn has not registered
   * yet. Callers that show a session's state to a person must read this rather
   * than their own busy probe: a probe that says idle while the gate is queueing
   * mail is a status that reads as "nothing is happening" at the exact moment
   * something is stuck.
   */
  isOccupied(sessionKey: string): boolean
  hasBuffered(sessionKey: string): boolean
  /** True if any session key matching `match` has a non-empty mailbox. */
  hasAnyBuffered(match: (sessionKey: string) => boolean): boolean
  /**
   * Hard-discard every session matching `match`: buffered jobs are dropped,
   * buffered relayed runs are rejected with `reason`, pending recheck timers
   * are cleared, and the reservation (if any) is released — unless its turn is
   * still streaming. Returns how many buffered JOBS (not relayed runs) were
   * dropped, for the caller to log.
   *
   * The streaming exception is the watchdog's rule (§7) applied here: freeing a
   * slot whose turn is still producing lets the very next delivery start a
   * second turn on that session, the corruption this lock exists to prevent.
   * Discarding hard-resets what has NOT started — the mail and its timers —
   * never what has. The kept slot is not stranded: it is released by that
   * turn's own completion report, which the caller must keep firing even for a
   * session it is tearing down, with the watchdog (if armed) as the backstop
   * for a report that never comes.
   */
  discard(match: (sessionKey: string) => boolean, reason: string): number
}

type MailboxEntry<TJob> =
  | { kind: 'job'; job: TJob }
  | {
      kind: 'relayed'
      /** Called with the slot already reserved; releases it when it settles. */
      start: () => void
      /** The queue was discarded — fail the caller rather than strand it. */
      cancel: (reason: string) => void
    }

const LOG_TAG = '[TurnGate]'
const DEFAULT_BUFFER_CAP = 128
const DEFAULT_RECHECK_MS = 3000

export function createTurnGate<TJob>(hooks: TurnGateHooks<TJob>, options: TurnGateOptions<TJob> = {}): TurnGate<TJob> {
  const bufferCap = options.bufferCap ?? DEFAULT_BUFFER_CAP
  const recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS
  const reservationTtlMs = options.reservationTtlMs
  const describeJob = options.describeJob

  const mailboxes = new Map<string, MailboxEntry<TJob>[]>()
  const rechecks = new Map<string, NodeJS.Timeout>()
  // Session keys with a dispatch accepted but not yet released. `hooks.isBusy`
  // only turns true once the caller's own session layer registers the turn,
  // asynchronously after dispatch — two deliveries inside that window both read
  // "idle" and race two turns onto one session. Reserving synchronously at
  // dispatch closes that window.
  const reserved = new Set<string>()
  // One watchdog per reservation (see `armWatchdog`).
  const watchdogs = new Map<string, NodeJS.Timeout>()

  function describeEntry(entry: MailboxEntry<TJob>): string {
    if (entry.kind === 'relayed') return 'relayed turn'
    return describeJob ? describeJob(entry.job) : 'job'
  }

  function isOccupied(sessionKey: string): boolean {
    return hooks.isBusy(sessionKey) || reserved.has(sessionKey)
  }

  /**
   * A reservation is released by exactly one thing: the caller reporting its
   * turn ended. Every way that report can be lost — a bookkeeping throw on the
   * completion path, a turn that ends somewhere the caller never watches — locks
   * the session for the life of the process: mail only queues, the recheck timer
   * re-arms forever, and nothing observable says why. So the gate reclaims a
   * reservation it has held past the TTL.
   *
   * It never reclaims one while `hooks.isBusy` is true: that is a turn actually
   * streaming, and freeing its slot would start a second turn on the same
   * session — the corruption this lock exists to prevent. A long turn simply
   * re-arms the watchdog and is checked again later.
   *
   * No-op unless the caller asked for it (`reservationTtlMs`). A caller whose
   * own liveness test is richer than `isBusy` recovers its slots better than
   * this can, and arming a second, blinder reclaimer alongside that one would
   * free reservations it deliberately holds.
   */
  function armWatchdog(sessionKey: string): void {
    clearWatchdog(sessionKey)
    if (reservationTtlMs === undefined) return
    const timer = setTimeout(() => {
      watchdogs.delete(sessionKey)
      if (!reserved.has(sessionKey)) return
      if (hooks.isBusy(sessionKey)) {
        armWatchdog(sessionKey)
        return
      }
      const buffered = mailboxes.get(sessionKey)?.length ?? 0
      console.warn(
        `${LOG_TAG} Reclaiming a stranded reservation after ${reservationTtlMs}ms — its turn never ` +
          `reported an ending: session=${sessionKey} buffered=${buffered}`
      )
      release(sessionKey)
      drain(sessionKey)
    }, reservationTtlMs)
    if (typeof timer.unref === 'function') timer.unref()
    watchdogs.set(sessionKey, timer)
  }

  function clearWatchdog(sessionKey: string): void {
    const timer = watchdogs.get(sessionKey)
    if (timer) {
      clearTimeout(timer)
      watchdogs.delete(sessionKey)
    }
  }

  /** Take the slot and start its watchdog. The ONLY way `reserved` grows. */
  function reserve(sessionKey: string): void {
    reserved.add(sessionKey)
    armWatchdog(sessionKey)
  }

  function tryReserve(sessionKey: string): boolean {
    if (isOccupied(sessionKey)) return false
    reserve(sessionKey)
    return true
  }

  function release(sessionKey: string): void {
    reserved.delete(sessionKey)
    clearWatchdog(sessionKey)
  }

  function scheduleRecheck(sessionKey: string): void {
    if (rechecks.has(sessionKey)) return
    const timer = setTimeout(() => {
      rechecks.delete(sessionKey)
      drain(sessionKey)
    }, recheckMs)
    if (typeof timer.unref === 'function') timer.unref()
    rechecks.set(sessionKey, timer)
  }

  function enqueue(sessionKey: string, entry: MailboxEntry<TJob>, note?: string): void {
    const buffer = mailboxes.get(sessionKey) ?? []
    if (buffer.length >= bufferCap) {
      const shed = buffer.shift()
      console.warn(
        `${LOG_TAG} Mailbox full (${bufferCap}); shed oldest: session=${sessionKey} ` +
          `${shed ? describeEntry(shed) : ''}`
      )
      // A shed relayed run has a caller on another node holding a promise;
      // failing it now beats leaving it to a backstop measured in hours.
      if (shed?.kind === 'relayed') shed.cancel('mailbox overflow')
    }
    buffer.push(entry)
    mailboxes.set(sessionKey, buffer)
    console.log(
      `${LOG_TAG} Target busy, buffered: session=${sessionKey} ${describeEntry(entry)} ` +
        `bufferSize=${buffer.length}${note ? ` (${note})` : ''}`
    )
    scheduleRecheck(sessionKey)
  }

  /**
   * Whether the job may go to the turn that is running instead of behind it.
   * Four conditions, and each rules out a way mid-turn delivery would be wrong:
   *
   * - `reserved` — the running turn is one THIS gate dispatched. A session can
   *   also be busy with a turn the gate never saw (its owner typing into the
   *   same conversation), and handing someone else's message into that turn
   *   both derails a private exchange and runs it under whatever permissions
   *   that turn was granted, which is not what this sender was lent.
   * - `isBusy` — the turn is actually streaming. A reservation whose dispatch
   *   is still in flight has no session to hand anything to yet.
   * - empty mailbox — otherwise this job overtakes messages already queued for
   *   the same session, and the target reads them out of order. Out of order is
   *   worse than late: the whole point is that a later message can supersede an
   *   earlier one, which only holds if they arrive in the order they were sent.
   * - `deliverMidTurn` supplied — a caller that did not opt in keeps the
   *   original behavior.
   *
   * Answers null when the job went into the running turn, and otherwise WHY it
   * did not. The reason is not decoration: this path is invisible when it works,
   * and a guard refusing looks identical from outside — a message that queued.
   * Without it, "nothing happened" has four possible causes and no way to tell
   * them apart.
   */
  function tryDeliverMidTurn(sessionKey: string, job: TJob): string | null {
    if (!hooks.deliverMidTurn) return 'mid-turn delivery not offered by this caller'
    if (!reserved.has(sessionKey)) return 'the running turn is not one this gate dispatched'
    if (!hooks.isBusy(sessionKey)) return 'the dispatched turn is not streaming yet'
    if ((mailboxes.get(sessionKey)?.length ?? 0) > 0) return 'mail is already queued ahead of it'
    try {
      return hooks.deliverMidTurn(sessionKey, job) ? null : 'the caller could not hand it over'
    } catch (err) {
      // The mailbox is always available, so a hook that throws costs latency
      // rather than the message.
      console.error(`${LOG_TAG} deliverMidTurn threw; buffering instead:`, err)
      return 'the caller threw'
    }
  }

  async function deliver(
    sessionKey: string,
    job: TJob,
    onBusy: BusyDisposition = 'buffer'
  ): Promise<DeliverDisposition> {
    if (!tryReserve(sessionKey)) {
      if (onBusy === 'skip') {
        console.log(`${LOG_TAG} Target busy, skipped: session=${sessionKey}`)
        return 'skipped'
      }
      // Synchronous like the enqueue below, and for a sharper reason: the
      // decision reads "a turn is streaming right now", and anything awaited
      // between reading that and acting on it can let the turn end underneath
      // us — handing the job to a session that is no longer listening.
      const refusal = tryDeliverMidTurn(sessionKey, job)
      if (!refusal) {
        console.log(
          `${LOG_TAG} Delivered into the running turn: session=${sessionKey} ${describeEntry({ kind: 'job', job })}`
        )
        return 'mid_turn'
      }
      // Keep this path synchronous through to the return. A caller that
      // mirrors mailbox depth on its own (conversation-interop does, to reject
      // an overfull target instead of shedding) increments its counter after
      // awaiting this call; an await introduced here would let a drain
      // dispatch the job first and decrement a count that does not exist yet,
      // drifting that mirror permanently out of step.
      enqueue(sessionKey, { kind: 'job', job }, `not mid-turn: ${refusal}`)
      return 'buffered'
    }
    try {
      await hooks.dispatch(sessionKey, job)
    } catch (err) {
      // The dispatch itself failed — no turn is running and nothing will
      // release this later. Release now or the session stays fake-busy and
      // every later delivery strands in the mailbox.
      release(sessionKey)
      throw err
    }
    return 'dispatched'
  }

  function runExclusive<T>(sessionKey: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Called with the slot already reserved by whoever dequeued this entry;
      // it is ours to hand back on every exit, or the session stays fake-busy.
      const start = (): void => {
        let running: Promise<T>
        try {
          running = run()
        } catch (err) {
          release(sessionKey)
          drain(sessionKey)
          reject(err)
          return
        }
        running.then(
          (value) => {
            release(sessionKey)
            drain(sessionKey)
            resolve(value)
          },
          (err) => {
            release(sessionKey)
            drain(sessionKey)
            reject(err)
          }
        )
      }

      if (tryReserve(sessionKey)) {
        start()
        return
      }
      enqueue(sessionKey, {
        kind: 'relayed',
        start,
        cancel: (reason) => reject(new Error(`Relayed turn dropped before it ran: ${reason}`)),
      })
    })
  }

  function drain(sessionKey: string): void {
    const buffer = mailboxes.get(sessionKey)
    if (!buffer || buffer.length === 0) return
    if (isOccupied(sessionKey)) {
      // Re-arm: this recheck is already consumed, so leaving now would pin the
      // mail on the current turn ending — a turn that may hang for minutes.
      scheduleRecheck(sessionKey)
      return
    }

    const next = buffer.shift()!
    if (buffer.length === 0) mailboxes.delete(sessionKey)
    console.log(`${LOG_TAG} Draining mailbox: session=${sessionKey} ${describeEntry(next)} remaining=${buffer.length}`)
    reserve(sessionKey)

    if (next.kind === 'relayed') {
      // Already rendered and booked by whoever queued it: just run it. It
      // releases the slot and drains the next entry when it settles.
      next.start()
      return
    }

    void hooks.dispatch(sessionKey, next.job).catch((err) => {
      release(sessionKey)
      console.error(`${LOG_TAG} Failed to dispatch buffered job:`, err)
      // The rest of the buffer must not strand behind a failed dispatch.
      scheduleRecheck(sessionKey)
    })
  }

  function hasBuffered(sessionKey: string): boolean {
    const buf = mailboxes.get(sessionKey)
    return !!buf && buf.length > 0
  }

  function hasAnyBuffered(match: (sessionKey: string) => boolean): boolean {
    for (const [key, buf] of mailboxes) {
      if (match(key) && buf.length > 0) return true
    }
    return false
  }

  function discard(match: (sessionKey: string) => boolean, reason: string): number {
    let droppedJobs = 0
    for (const key of [...mailboxes.keys()]) {
      if (!match(key)) continue
      const entries = mailboxes.get(key) ?? []
      mailboxes.delete(key)
      for (const entry of entries) {
        if (entry.kind === 'relayed') entry.cancel(reason)
        else droppedJobs += 1
      }
    }
    for (const [key, timer] of [...rechecks]) {
      if (match(key)) {
        clearTimeout(timer)
        rechecks.delete(key)
      }
    }
    for (const key of [...reserved]) {
      if (!match(key)) continue
      // A slot whose turn is actually streaming keeps it, for the same reason
      // the watchdog refuses to reclaim one (§7): freeing it lets the very next
      // delivery start a second turn on a session that is still producing, which
      // is the corruption this lock exists to prevent. Discarding is a hard
      // reset of what has NOT started — the mail and its timers — not a way to
      // cut short what has. That turn ends on its own and its completion hands
      // the slot back, which is the only path that ever should.
      if (hooks.isBusy(key)) continue
      release(key)
    }
    return droppedJobs
  }

  return { deliver, runExclusive, release, drain, isOccupied, hasBuffered, hasAnyBuffered, discard }
}
