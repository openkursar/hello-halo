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
export type DeliverDisposition = 'dispatched' | 'buffered' | 'skipped'

export interface TurnGateHooks<TJob> {
  /** Resolves once the job is accepted/started, NOT when it finishes. */
  dispatch(sessionKey: string, job: TJob): Promise<void>
  isBusy(sessionKey: string): boolean
}

export interface TurnGateOptions<TJob> {
  /** Upper bound of buffered entries per session mailbox. Default 128. */
  bufferCap?: number
  /** Backstop recheck interval after buffering, in ms. Default 3000. */
  recheckMs?: number
  /** One-line description of a job, for log lines only. */
  describeJob?: (job: TJob) => string
}

export interface TurnGate<TJob> {
  /**
   * Dispatch now if the session is free, otherwise queue behind whatever is
   * running (`onBusy: 'buffer'`, the default) or drop it (`'skip'`, for a wake
   * that repeats on its own rhythm and should not pile up missed rounds).
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
  hasBuffered(sessionKey: string): boolean
  /** True if any session key matching `match` has a non-empty mailbox. */
  hasAnyBuffered(match: (sessionKey: string) => boolean): boolean
  /**
   * Hard-discard every session matching `match`: buffered jobs are dropped,
   * buffered relayed runs are rejected with `reason`, pending recheck timers
   * are cleared, and the reservation (if any) is released. Returns how many
   * buffered JOBS (not relayed runs) were dropped, for the caller to log.
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
  const describeJob = options.describeJob

  const mailboxes = new Map<string, MailboxEntry<TJob>[]>()
  const rechecks = new Map<string, NodeJS.Timeout>()
  // Session keys with a dispatch accepted but not yet released. `hooks.isBusy`
  // only turns true once the caller's own session layer registers the turn,
  // asynchronously after dispatch — two deliveries inside that window both read
  // "idle" and race two turns onto one session. Reserving synchronously at
  // dispatch closes that window.
  const reserved = new Set<string>()

  function describeEntry(entry: MailboxEntry<TJob>): string {
    if (entry.kind === 'relayed') return 'relayed turn'
    return describeJob ? describeJob(entry.job) : 'job'
  }

  function isOccupied(sessionKey: string): boolean {
    return hooks.isBusy(sessionKey) || reserved.has(sessionKey)
  }

  function tryReserve(sessionKey: string): boolean {
    if (isOccupied(sessionKey)) return false
    reserved.add(sessionKey)
    return true
  }

  function release(sessionKey: string): void {
    reserved.delete(sessionKey)
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

  function enqueue(sessionKey: string, entry: MailboxEntry<TJob>): void {
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
      `${LOG_TAG} Target busy, buffered: session=${sessionKey} ${describeEntry(entry)} bufferSize=${buffer.length}`
    )
    scheduleRecheck(sessionKey)
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
      // Keep this path synchronous through to the return. A caller that
      // mirrors mailbox depth on its own (conversation-interop does, to reject
      // an overfull target instead of shedding) increments its counter after
      // awaiting this call; an await introduced here would let a drain
      // dispatch the job first and decrement a count that does not exist yet,
      // drifting that mirror permanently out of step.
      enqueue(sessionKey, { kind: 'job', job })
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
    reserved.add(sessionKey)

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
      if (match(key)) reserved.delete(key)
    }
    return droppedJobs
  }

  return { deliver, runExclusive, release, drain, hasBuffered, hasAnyBuffered, discard }
}
