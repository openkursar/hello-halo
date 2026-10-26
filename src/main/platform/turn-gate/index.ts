/** Permission-aware mailbox and exclusive turn reservation, independent of any chat surface. */
export type BusyDisposition = 'buffer' | 'skip'
export type DeliverDisposition = 'dispatched' | 'mid_turn' | 'buffered' | 'skipped'

export interface TurnGateHooks<TJob> {
  /** Resolves on acceptance, not completion. A rejection means nothing was accepted. */
  dispatch(sessionKey: string, job: TJob): Promise<void>
  isBusy(sessionKey: string): boolean
  /** Unknown identities never combine, including with another unknown identity. */
  getJobIdentity?(job: TJob): string | undefined
  getActiveIdentity?(sessionKey: string): string | undefined
  /** Preserve the individual records and their order inside the combined input. */
  mergeJobs?(jobs: readonly TJob[]): TJob
  /** Revalidate deferred notices in place; undefined cancels them without changing queue order. */
  refreshJob?(job: TJob): TJob | undefined
  /** Atomic, synchronous acceptance of the entire batch; false leaves ownership with the gate. */
  deliverMidTurn?(sessionKey: string, job: TJob): boolean
}

export interface TurnGateOptions<TJob> {
  bufferCap?: number
  recheckMs?: number
  /** Only callers whose busy probe covers all dispatch activity should enable recovery. */
  reservationTtlMs?: number
  describeJob?: (job: TJob) => string
  /** A permanently invalid target can refuse retries; onDiscard settles the original callers. */
  retryDispatch?: (error: unknown, job: TJob) => boolean
  getCoalescingKey?: (job: TJob) => string | undefined
  /** Called for explicit teardown and supersession; accepted messages are never shed on overflow. */
  onDiscard?: (job: TJob, reason: string) => void
  /** False: the job may join a running turn or ride with one that opens a turn, but never opens one itself. */
  canOpenTurn?: (job: TJob) => boolean
}

export interface TurnGate<TJob> {
  deliver(sessionKey: string, job: TJob, onBusy?: BusyDisposition): Promise<DeliverDisposition>
  /** Offer without taking mailbox ownership; false leaves the caller's durable spool untouched. */
  tryDeliverLive(sessionKey: string, job: TJob): boolean
  /** Exclusive callbacks form FIFO barriers; messages never cross one to join a different turn. */
  runExclusive<T>(sessionKey: string, run: () => Promise<T>): Promise<T>
  release(sessionKey: string): void
  drain(sessionKey: string): void
  /** The consumer has a live turn now, including turns started outside this gate. */
  notifyReady(sessionKey: string): void
  isOccupied(sessionKey: string): boolean
  /** Read-only view of queued jobs; dispatched work and exclusive callbacks are not included. */
  bufferedJobs(sessionKey: string): readonly Readonly<TJob>[]
  bufferedCount(sessionKey: string): number
  hasBuffered(sessionKey: string): boolean
  hasAnyBuffered(match: (sessionKey: string) => boolean): boolean
  discard(match: (sessionKey: string) => boolean, reason: string): number
  discardJobs(match: (sessionKey: string, job: TJob) => boolean, reason: string): number
  /**
   * A person stopped this session's work: what waits for it, and what is put back
   * later, starts nothing and joins nothing until the next accepted delivery,
   * turn start or exclusive callback for this session.
   */
  park(sessionKey: string): void
  /**
   * Jobs taken back from a stopped turn, ahead of the waiting ones. They wait
   * with the session while it is held; once something released it, they join
   * the ordinary flow at once.
   */
  putBack(sessionKey: string, jobs: readonly TJob[]): void
}

export class TurnGateCapacityError extends Error {
  constructor(sessionKey: string) {
    super(`Conversation mailbox is full: ${sessionKey}`)
    this.name = 'TurnGateCapacityError'
  }
}

type JobEntry<TJob> = { kind: 'job'; job: TJob; identity: string | undefined; coalescingKey?: string; refreshFailed?: boolean }
type DispatchAttempt<TJob> = { entries: JobEntry<TJob>[]; cancelledReason?: string }
type MailboxEntry<TJob> = JobEntry<TJob> | { kind: 'relayed'; start: () => void; cancel: (reason: string) => void }

const LOG_TAG = '[TurnGate]'

export function createTurnGate<TJob>(hooks: TurnGateHooks<TJob>, options: TurnGateOptions<TJob> = {}): TurnGate<TJob> {
  const bufferCap = options.bufferCap ?? 128
  const recheckMs = options.recheckMs ?? 3000
  if (!Number.isInteger(bufferCap) || bufferCap < 1) throw new Error('bufferCap must be a positive integer')
  const mailboxes = new Map<string, MailboxEntry<TJob>[]>()
  const reserved = new Map<string, symbol>()
  const pendingDispatches = new Map<string, Set<DispatchAttempt<TJob>>>()
  const rechecks = new Map<string, NodeJS.Timeout>()
  const watchdogs = new Map<string, NodeJS.Timeout>()
  const parked = new Set<string>()
  // Jobs put back since the hold began, at the head of the mailbox in their original order.
  const returnedSinceHold = new Map<string, number>()

  function describeEntries(entries: readonly JobEntry<TJob>[]): string {
    if (!options.describeJob) return ''
    try {
      const labels = entries.slice(0, 3).map(entry => options.describeJob!(entry.job).replace(/[\r\n]/g, ' ').slice(0, 128))
      return ` jobs=${labels.join(',')}${entries.length > labels.length ? `,+${entries.length - labels.length}` : ''}`
    } catch {
      return ' jobDescription=unavailable'
    }
  }

  function isOccupied(key: string): boolean {
    return reserved.has(key) || hooks.isBusy(key)
  }

  function clearTimer(timers: Map<string, NodeJS.Timeout>, key: string): void {
    const timer = timers.get(key)
    if (timer) clearTimeout(timer)
    timers.delete(key)
  }

  function release(key: string): void {
    reserved.delete(key)
    clearTimer(watchdogs, key)
  }

  function armWatchdog(key: string): void {
    clearTimer(watchdogs, key)
    if (options.reservationTtlMs === undefined) return
    const generation = reserved.get(key)
    const timer = setTimeout(() => {
      watchdogs.delete(key)
      if (reserved.get(key) !== generation) return
      if (hooks.isBusy(key)) {
        armWatchdog(key)
        return
      }
      if (reserved.get(key) !== generation) return
      console.warn(`${LOG_TAG} Reclaiming stranded reservation: session=${key} buffered=${bufferedCount(key)}`)
      release(key)
      drain(key)
    }, options.reservationTtlMs)
    timer.unref?.()
    watchdogs.set(key, timer)
  }

  function reserve(key: string): symbol {
    const generation = Symbol(key)
    reserved.set(key, generation)
    armWatchdog(key)
    return generation
  }

  function scheduleRecheck(key: string): void {
    if (rechecks.has(key) || parked.has(key)) return
    const timer = setTimeout(() => {
      rechecks.delete(key)
      drain(key)
    }, recheckMs)
    timer.unref?.()
    rechecks.set(key, timer)
  }

  function storeMailbox(key: string, entries: MailboxEntry<TJob>[]): void {
    if (entries.length) mailboxes.set(key, entries)
    else {
      mailboxes.delete(key)
      clearTimer(rechecks, key)
    }
  }

  function rejectEntry(entry: MailboxEntry<TJob>, reason: string): void {
    if (entry.kind === 'relayed') entry.cancel(reason)
    else {
      try { options.onDiscard?.(entry.job, reason) } catch (error) {
        console.error(`${LOG_TAG} Discard callback failed: reason=${reason}`, error)
      }
    }
  }

  function enqueue(key: string, entry: MailboxEntry<TJob>): void {
    const buffer = mailboxes.get(key) ?? []
    if (entry.kind === 'job' && entry.coalescingKey !== undefined && entry.identity !== undefined) {
      // Supersession stays inside the current barrier segment and permission group.
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        const previous = buffer[index]
        if (previous.kind === 'relayed') break
        if (previous.identity === entry.identity && previous.coalescingKey === entry.coalescingKey) {
          buffer.splice(index, 1)
          rejectEntry(previous, 'superseded')
          break
        }
      }
    }
    if (buffer.length >= bufferCap) {
      console.warn(`${LOG_TAG} Mailbox full; new delivery refused: session=${key} capacity=${bufferCap}`)
      throw new TurnGateCapacityError(key)
    }
    buffer.push(entry)
    mailboxes.set(key, buffer)
    scheduleRecheck(key)
  }

  function refreshEntry(key: string, entry: JobEntry<TJob>): boolean {
    if (!hooks.refreshJob) return true
    try {
      const refreshed = hooks.refreshJob(entry.job)
      if (refreshed === undefined) return false
      entry.job = refreshed
      entry.identity = hooks.getJobIdentity?.(refreshed)
      entry.coalescingKey = options.getCoalescingKey?.(refreshed)
      entry.refreshFailed = false
      return true
    } catch (error) {
      entry.identity = undefined
      entry.refreshFailed = true
      console.warn(`${LOG_TAG} Deferred delivery could not be revalidated; retaining input: session=${key}`, error)
      return true
    }
  }

  function refreshMailbox(key: string): void {
    if (!hooks.refreshJob) return
    const kept: MailboxEntry<TJob>[] = []
    const superseded = new Set<MailboxEntry<TJob>>()
    const coalescing = new Map<string, Map<string, JobEntry<TJob>>>()
    const discarded: Array<{ entry: MailboxEntry<TJob>; reason: string }> = []
    for (const entry of mailboxes.get(key) ?? []) {
      if (entry.kind === 'relayed') {
        coalescing.clear()
        kept.push(entry)
        continue
      }
      if (!refreshEntry(key, entry)) {
        discarded.push({ entry, reason: 'no longer valid' })
        continue
      }
      if (entry.identity !== undefined && entry.coalescingKey !== undefined) {
        const group = coalescing.get(entry.identity) ?? new Map<string, JobEntry<TJob>>()
        const previous = group.get(entry.coalescingKey)
        if (previous) {
          superseded.add(previous)
          discarded.push({ entry: previous, reason: 'superseded' })
        }
        group.set(entry.coalescingKey, entry)
        coalescing.set(entry.identity, group)
      }
      kept.push(entry)
    }
    storeMailbox(key, kept.filter((entry) => !superseded.has(entry)))
    for (const { entry, reason } of discarded) rejectEntry(entry, reason)
    if (discarded.length) console.log(`${LOG_TAG} Revalidated pending deliveries: session=${key} removed=${discarded.length}`)
  }

  function merge(entries: readonly JobEntry<TJob>[]): TJob {
    return entries.length === 1 ? entries[0].job : hooks.mergeJobs!(entries.map((entry) => entry.job))
  }

  function matchingJobs(key: string, identity: string | undefined): JobEntry<TJob>[] {
    if (identity === undefined) return []
    const selected: JobEntry<TJob>[] = []
    for (const entry of mailboxes.get(key) ?? []) {
      if (entry.kind === 'relayed') break
      if (entry.refreshFailed || entry.identity !== identity) continue
      selected.push(entry)
      if (!hooks.mergeJobs) break
    }
    return selected
  }

  function removeEntries(key: string, entries: readonly MailboxEntry<TJob>[]): void {
    const removed = new Set(entries)
    storeMailbox(key, (mailboxes.get(key) ?? []).filter((entry) => !removed.has(entry)))
  }

  function flushLive(key: string, offered?: JobEntry<TJob>, refresh = true): { accepted: JobEntry<TJob>[]; reason: string } {
    if (parked.has(key)) return { accepted: [], reason: 'held after a stop' }
    if (refresh) refreshMailbox(key)
    if (offered && (!refreshEntry(key, offered) || offered.refreshFailed)) return { accepted: [], reason: 'offered input no longer valid' }
    if (!hooks.isBusy(key)) return { accepted: [], reason: 'turn starting or ending' }
    const identity = hooks.getActiveIdentity?.(key)
    if (identity === undefined) return { accepted: [], reason: 'active permissions unknown' }
    const entries = matchingJobs(key, identity)
    if (offered) {
      if (offered.identity !== identity) return { accepted: [], reason: 'different permissions' }
      if ((mailboxes.get(key) ?? []).some((entry) => entry.kind === 'relayed')) {
        return { accepted: [], reason: 'exclusive barrier' }
      }
      if (entries.length && !hooks.mergeJobs) return { accepted: [], reason: 'pending compatible delivery' }
      entries.push(offered)
    }
    if (!entries.length) return { accepted: [], reason: 'different permissions or exclusive barrier' }
    if (!hooks.deliverMidTurn) return { accepted: [], reason: 'live delivery unavailable' }
    try {
      if (hooks.deliverMidTurn(key, merge(entries))) {
        removeEntries(key, entries)
        console.log(`${LOG_TAG} Delivered into running turn: session=${key} count=${entries.length}${describeEntries(entries)}`)
        return { accepted: entries, reason: 'accepted' }
      }
    } catch (err) {
      console.error(`${LOG_TAG} Live delivery failed; retaining mailbox: session=${key}`, err)
    }
    return { accepted: [], reason: 'live delivery declined; retained for next turn' }
  }

  function tryDeliverLive(key: string, job: TJob): boolean {
    const entry: JobEntry<TJob> = { kind: 'job', job, identity: hooks.getJobIdentity?.(job) }
    return flushLive(key, entry).accepted.includes(entry)
  }

  async function dispatchEntries(
    key: string,
    entries: JobEntry<TJob>[],
    attempt: DispatchAttempt<TJob> = { entries },
  ): Promise<void> {
    const generation = reserve(key)
    const attempts = pendingDispatches.get(key) ?? new Set<DispatchAttempt<TJob>>()
    attempts.add(attempt)
    pendingDispatches.set(key, attempts)
    try {
      await hooks.dispatch(key, merge(entries))
    } catch (err) {
      if (reserved.get(key) === generation) release(key)
      throw err
    } finally {
      attempts.delete(attempt)
      if (attempts.size === 0 && pendingDispatches.get(key) === attempts) pendingDispatches.delete(key)
    }
  }

  async function deliver(key: string, job: TJob, onBusy: BusyDisposition = 'buffer'): Promise<DeliverDisposition> {
    const entry: JobEntry<TJob> = {
      kind: 'job', job, identity: hooks.getJobIdentity?.(job), coalescingKey: options.getCoalescingKey?.(job),
    }
    refreshMailbox(key)
    if (!refreshEntry(key, entry)) {
      rejectEntry(entry, 'no longer valid')
      return 'skipped'
    }
    if (!entry.refreshFailed && !isOccupied(key) && !hasBuffered(key)) {
      unpark(key)
      await dispatchEntries(key, [entry])
      console.log(`${LOG_TAG} Started turn: session=${key} count=1${describeEntries([entry])}`)
      return 'dispatched'
    }
    if (onBusy === 'skip') {
      console.log(`${LOG_TAG} Repeated run skipped while occupied: session=${key}`)
      return 'skipped'
    }
    unpark(key)
    // Capacity is measured after any compatible accepted mail has left the inbox.
    if (bufferedCount(key) >= bufferCap) flushLive(key, undefined, false)
    enqueue(key, entry)
    const flushed = flushLive(key, undefined, false)
    if (flushed.accepted.includes(entry)) return 'mid_turn'
    console.log(`${LOG_TAG} Buffered delivery: session=${key} count=${bufferedCount(key)} reason=${flushed.reason}${describeEntries([entry])}`)
    // A declined live send can race the final result; retry idle dispatch immediately.
    if (!isOccupied(key)) drain(key, false)
    return 'buffered'
  }

  function runExclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    unpark(key)
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        const generation = reserved.get(key)
        const releaseOwn = (): void => {
          if (reserved.get(key) !== generation) return
          release(key)
          drain(key)
        }
        let running: Promise<T>
        try { running = run() } catch (err) {
          releaseOwn()
          reject(err)
          return
        }
        running.then((result) => {
          releaseOwn()
          resolve(result)
        }, (err) => {
          releaseOwn()
          reject(err)
        })
      }
      if (!isOccupied(key) && !hasBuffered(key)) {
        reserve(key)
        start()
      } else {
        enqueue(key, { kind: 'relayed', start, cancel: (reason) => reject(new Error(`Relayed turn dropped before it ran: ${reason}`)) })
        if (!isOccupied(key)) drain(key)
      }
    })
  }

  /** The earliest group allowed to open a turn; groups that may only join one keep waiting. */
  function openingGroup(key: string): JobEntry<TJob>[] | undefined {
    const tried = new Set<string>()
    for (const entry of mailboxes.get(key) ?? []) {
      if (entry.kind === 'relayed') return undefined
      if (entry.refreshFailed) continue
      if (entry.identity !== undefined) {
        if (tried.has(entry.identity)) continue
        tried.add(entry.identity)
      }
      const group = entry.identity === undefined ? [entry] : matchingJobs(key, entry.identity)
      if (!options.canOpenTurn || options.canOpenTurn(merge(group))) return group
    }
    return undefined
  }

  function drain(key: string, refresh = true): void {
    if (parked.has(key)) return
    if (refresh) refreshMailbox(key)
    if (!hasBuffered(key)) return
    if (isOccupied(key)) {
      flushLive(key, undefined, false)
      if (hasBuffered(key)) scheduleRecheck(key)
      return
    }
    const first = mailboxes.get(key)![0]
    if (first.kind === 'relayed') {
      removeEntries(key, [first])
      reserve(key)
      first.start()
      return
    }
    if (first.refreshFailed) {
      scheduleRecheck(key)
      return
    }
    // Waiting only to join a turn: the next delivery or turn start drains again.
    const entries = openingGroup(key)
    if (!entries) return
    removeEntries(key, entries)
    console.log(`${LOG_TAG} Starting buffered turn: session=${key} count=${entries.length} remaining=${bufferedCount(key)}${describeEntries(entries)}`)
    const attempt: DispatchAttempt<TJob> = { entries }
    void dispatchEntries(key, entries, attempt).catch((err) => {
      if (attempt.cancelledReason !== undefined) {
        console.warn(`${LOG_TAG} Cancelled dispatch failed; no retry: session=${key} reason=${attempt.cancelledReason}`)
        return
      }
      if (options.retryDispatch && !options.retryDispatch(err, merge(entries))) {
        console.error(`${LOG_TAG} Buffered dispatch permanently refused: session=${key} count=${entries.length}${describeEntries(entries)}`, err)
        for (const entry of entries) rejectEntry(entry, err instanceof Error ? err.message : String(err))
        if (hasBuffered(key)) scheduleRecheck(key)
        return
      }
      // Accepted queued work stays owned here until a dispatch succeeds or explicit teardown cancels it.
      storeMailbox(key, [...entries, ...(mailboxes.get(key) ?? [])])
      console.error(`${LOG_TAG} Buffered dispatch failed; retaining messages: session=${key} count=${entries.length}${describeEntries(entries)}`, err)
      scheduleRecheck(key)
    })
  }

  function notifyReady(key: string): void {
    unpark(key)
    flushLive(key)
    if (hasBuffered(key)) scheduleRecheck(key)
  }

  function unpark(key: string): void {
    returnedSinceHold.delete(key)
    if (!parked.delete(key)) return
    console.log(`${LOG_TAG} Releasing deliveries held since a stop: session=${key} count=${bufferedCount(key)}`)
  }

  // Held even with nothing waiting: input taken back from the stopped turn may
  // arrive later. A held key costs one entry until its next delivery or turn start.
  function park(key: string): void {
    parked.add(key)
    returnedSinceHold.delete(key)
    clearTimer(rechecks, key)
    console.log(`${LOG_TAG} Holding deliveries after a stop: session=${key} count=${bufferedCount(key)}`)
  }

  function putBack(key: string, jobs: readonly TJob[]): void {
    const waiting = mailboxes.get(key) ?? []
    const entries: JobEntry<TJob>[] = []
    for (const job of jobs) {
      const entry: JobEntry<TJob> = {
        kind: 'job', job, identity: hooks.getJobIdentity?.(job), coalescingKey: options.getCoalescingKey?.(job),
      }
      // A newer notice of the same kind already waiting replaces the returned one.
      const newer = entry.identity !== undefined && entry.coalescingKey !== undefined && waiting.some(other =>
        other.kind === 'job' && other.identity === entry.identity && other.coalescingKey === entry.coalescingKey)
      if (newer) rejectEntry(entry, 'superseded')
      else entries.push(entry)
    }
    if (!entries.length) return
    const held = parked.has(key)
    // Several take-backs from one stop keep their arrival order, all ahead of what waited.
    const at = held ? Math.min(returnedSinceHold.get(key) ?? 0, waiting.length) : 0
    if (held) returnedSinceHold.set(key, at + entries.length)
    // Taken back from the turn, never refused: the capacity bound applies to new arrivals.
    storeMailbox(key, [...waiting.slice(0, at), ...entries, ...waiting.slice(at)])
    console.log(`${LOG_TAG} Taken back from a stopped turn: session=${key} count=${entries.length} held=${held}`)
    if (!held) drain(key)
  }

  function bufferedJobs(key: string): readonly Readonly<TJob>[] {
    return (mailboxes.get(key) ?? []).flatMap(entry => entry.kind === 'job' ? [entry.job] : [])
  }

  function bufferedCount(key: string): number { return mailboxes.get(key)?.length ?? 0 }
  function hasBuffered(key: string): boolean { return bufferedCount(key) > 0 }
  function hasAnyBuffered(match: (key: string) => boolean): boolean {
    for (const key of mailboxes.keys()) if (match(key)) return true
    return false
  }

  function discardJobs(match: (key: string, job: TJob) => boolean, reason: string): number {
    let dropped = 0
    for (const [key, entries] of mailboxes) {
      const removed = entries.filter((entry): entry is JobEntry<TJob> => entry.kind === 'job' && match(key, entry.job))
      if (!removed.length) continue
      removeEntries(key, removed)
      for (const entry of removed) rejectEntry(entry, reason)
      dropped += removed.length
      console.warn(`${LOG_TAG} Pending deliveries cancelled: session=${key} count=${removed.length} reason=${reason}`)
    }
    return dropped
  }

  function discard(match: (key: string) => boolean, reason: string): number {
    let dropped = 0
    for (const [key, attempts] of [...pendingDispatches]) {
      if (!match(key)) continue
      for (const attempt of attempts) {
        if (attempt.cancelledReason !== undefined) continue
        attempt.cancelledReason = reason
        for (const entry of attempt.entries) rejectEntry(entry, reason)
        dropped += attempt.entries.length
        console.warn(`${LOG_TAG} Pending dispatch cancelled: session=${key} count=${attempt.entries.length} reason=${reason}`)
      }
    }
    for (const [key, entries] of mailboxes) {
      if (!match(key)) continue
      storeMailbox(key, [])
      for (const entry of entries) {
        if (entry.kind === 'job') dropped += 1
        rejectEntry(entry, reason)
      }
      console.warn(`${LOG_TAG} Mailbox discarded: session=${key} count=${entries.length} reason=${reason}`)
    }
    for (const [key, generation] of [...reserved]) {
      if (match(key) && !hooks.isBusy(key) && reserved.get(key) === generation) release(key)
    }
    for (const key of [...parked]) {
      if (!match(key)) continue
      parked.delete(key)
      returnedSinceHold.delete(key)
    }
    return dropped
  }

  return { deliver, tryDeliverLive, runExclusive, release, drain, notifyReady, isOccupied, bufferedJobs, bufferedCount, hasBuffered, hasAnyBuffered, discard, discardJobs, park, putBack }
}
