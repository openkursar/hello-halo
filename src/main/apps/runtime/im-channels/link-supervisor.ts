/**
 * apps/runtime/im-channels -- Link supervisor
 *
 * Keeps one IM channel's long-lived link up. Providers own the protocol (how to
 * dial, what "up" means, what a platform error says); the supervisor owns the
 * one thing every channel needs and none of the SDKs get fully right on its
 * own — that a link which is not up is always either being dialled under a
 * deadline or waiting for a scheduled redial, and never just stuck:
 *
 *   - every attempt must come up within `attemptTimeoutMs`, or it counts as
 *     failed — a proxy that accepts the connection and then says nothing can
 *     no longer hold a channel forever;
 *   - failures are retried after a jittered backoff (1 s doubling to 30 s), and
 *     only an explicit halt (a credential the platform rejected) stops that;
 *   - waking from sleep, a network change and a change of the IM route redial
 *     at once instead of waiting out the backoff or a heartbeat;
 *   - a link reported up whose transport says otherwise is noticed on the
 *     shared tick.
 *
 * A redial is always a fresh `dial()`, which resolves the route again, so a
 * settings change reaches the very next attempt. The supervisor holds one
 * timer at a time and never touches sockets.
 */

import type { ImLinkStatus } from '../../../../shared/types/im-channel'
import { watchLinkSignals, type LinkSignal } from './link-signals'

export type LinkLogLevel = 'info' | 'warn' | 'error'
export type LinkLogFields = Record<string, string | number | boolean | null | undefined>

export interface LinkSupervisorOptions {
  /** Writes one line in the provider's own log format. */
  log: (level: LinkLogLevel, event: string, fields: LinkLogFields) => void
  /**
   * Replace whatever attempt or connection exists with a fresh one. Reports
   * back through connected() / lost(); may resolve its route asynchronously.
   */
  dial: () => void
  /** Whether the transport is really up; checked on the shared tick while online. */
  isUp: () => boolean
  /** Longest an attempt (or a transport's own reconnect) may take to come up. */
  attemptTimeoutMs: number
  /** Injectable randomness in [0, 1), for deterministic tests. */
  random?: () => number
}

type Phase =
  /** Not started, or stopped. */
  | 'idle'
  /** An attempt is in flight under the deadline. */
  | 'dialing'
  | 'online'
  /** A redial is scheduled. */
  | 'waiting'
  /** Given up until the user acts. */
  | 'halted'

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

const SIGNAL_REASONS: Record<LinkSignal, string> = {
  resume: 'system woke from sleep',
  'network-changed': 'network changed',
  'route-changed': 'message channel proxy settings changed',
}

/** Rejections of the credentials before stopping — the WeCom SDK's own budget. */
const MAX_CREDENTIAL_REJECTIONS = 5
/**
 * Least time from the first rejection to stopping. A bot or app created
 * moments ago may be refused until the platform knows it; a credential that is
 * really wrong is only shown as stopped a little later.
 */
const CREDENTIAL_REJECTION_GRACE_MS = 60_000

/**
 * When a platform's repeated "no" to a bot's credentials means stopping
 * (`LinkSupervisor.halt`) rather than retrying: five rejections, the first a
 * minute or more ago, counted since the provider last reset it — on start, on
 * a connection and on the user's reconnect. Failures of other kinds in between
 * neither count nor reset it. One rule for every channel that can tell a
 * rejected credential from a network failure.
 */
export class CredentialRejectionBudget {
  private count = 0
  private firstAt = 0

  /** Records one rejection; true when the link should stop. */
  record(now = Date.now()): boolean {
    if (this.count === 0) this.firstAt = now
    this.count++
    return this.count >= MAX_CREDENTIAL_REJECTIONS && now - this.firstAt >= CREDENTIAL_REJECTION_GRACE_MS
  }

  reset(): void {
    this.count = 0
    this.firstAt = 0
  }
}

export class LinkSupervisor {
  private readonly opts: LinkSupervisorOptions
  private readonly random: () => number
  private phase: Phase = 'idle'
  /** A redial the caller paced (slot arbitration) — wake signals leave it alone. */
  private callerPaced = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextRetryAt: number | undefined
  private failures = 0
  private drops = 0
  private everOnline = false
  private viaProxy = false
  private lastError: string | undefined
  private downSince = 0
  private stopSignals: (() => void) | null = null

  constructor(opts: LinkSupervisorOptions) {
    this.opts = opts
    this.random = opts.random ?? Math.random
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  start(): void {
    this.clearTimer()
    this.failures = 0
    this.drops = 0
    this.everOnline = false
    this.lastError = undefined
    this.downSince = Date.now()
    if (!this.stopSignals) {
      this.stopSignals = watchLinkSignals({
        onSignal: (signal) => this.onSignal(signal),
        onTick: () => this.onTick(),
      })
    }
    this.dialNow()
  }

  stop(): void {
    this.clearTimer()
    this.phase = 'idle'
    this.stopSignals?.()
    this.stopSignals = null
  }

  // ── Reports from the provider ─────────────────────────────────

  /** The link is up. */
  connected(): void {
    if (this.phase === 'idle' || this.phase === 'halted' || this.phase === 'online') return
    this.clearTimer()
    this.opts.log('info', 'link_online', {
      afterFailures: this.failures,
      downMs: Date.now() - this.downSince,
      viaProxy: this.viaProxy,
    })
    this.phase = 'online'
    this.failures = 0
    this.everOnline = true
    this.lastError = undefined
  }

  /**
   * The attempt failed or the link went down, and nothing will bring it back
   * on its own: redial after the backoff.
   */
  lost(reason: string): void {
    if (this.phase !== 'dialing' && this.phase !== 'online') return
    this.fail(reason)
  }

  /**
   * The link went down but the transport is reconnecting by itself. It gets
   * one attempt deadline to succeed before the supervisor takes over.
   */
  dropped(reason: string): void {
    if (this.phase !== 'online') return
    this.markDown(reason)
    this.phase = 'dialing'
    this.armDeadline()
    this.opts.log('warn', 'link_dropped', { reason, viaProxy: this.viaProxy })
  }

  /**
   * Redial after a delay the caller chose, e.g. to stop two devices fighting
   * over one bot. `interrupted` says whether losing the current link counts as
   * a drop; an expected one (a standby probe being taken over) does not.
   */
  redialIn(delayMs: number, reason: string, interrupted = true): void {
    if (this.phase === 'idle' || this.phase === 'halted') return
    if (this.phase === 'online') {
      if (interrupted) this.markDown(reason)
      else this.downSince = Date.now()
    }
    this.schedule(delayMs, true)
    this.opts.log('info', 'link_redial_scheduled', { reason, delayMs })
  }

  /** Redial at once with the backoff reset — the user asked, or the world changed. */
  redialNow(reason: string): void {
    if (this.phase === 'idle') return
    if (this.phase === 'online') this.downSince = Date.now()
    this.failures = 0
    this.opts.log('info', 'link_redial', { reason })
    this.dialNow()
  }

  /** Stop retrying: the failure needs the user (rejected credential, expired session). */
  halt(reason: string): void {
    if (this.phase === 'idle' || this.phase === 'halted') return
    this.clearTimer()
    this.phase = 'halted'
    this.lastError = reason
    this.opts.log('error', 'link_halted', { reason, failures: this.failures })
  }

  /** Records which route the current attempt took. */
  noteRoute(viaProxy: boolean): void {
    this.viaProxy = viaProxy
  }

  // ── Status ────────────────────────────────────────────────────

  /** Started and not stopped — the instance has a link to keep up. */
  isRunning(): boolean {
    return this.phase !== 'idle'
  }

  isHalted(): boolean {
    return this.phase === 'halted'
  }

  /** Whether the link was up at some point since start() — reconnecting rather than connecting. */
  wasEverOnline(): boolean {
    return this.everOnline
  }

  status(): ImLinkStatus {
    return {
      attempt: this.failures,
      nextRetryAt: this.phase === 'waiting' ? this.nextRetryAt : undefined,
      lastError: this.lastError,
      viaProxy: this.viaProxy,
      drops: this.drops,
    }
  }

  /** One-line summary for the provider's periodic health snapshot. */
  snapshotFields(): LinkLogFields {
    return {
      link: this.phase,
      linkFailures: this.failures,
      linkDrops: this.drops,
      viaProxy: this.viaProxy,
      linkError: this.lastError,
    }
  }

  // ── Internals ─────────────────────────────────────────────────

  private dialNow(): void {
    this.clearTimer()
    this.phase = 'dialing'
    this.armDeadline()
    this.opts.dial()
  }

  private fail(reason: string): void {
    if (this.phase === 'online') this.markDown(reason)
    this.lastError = reason
    const delayMs = this.backoff()
    this.failures++
    this.schedule(delayMs, false)
    this.opts.log('warn', 'link_retry_scheduled', {
      reason,
      failures: this.failures,
      delayMs,
      viaProxy: this.viaProxy,
    })
  }

  private markDown(reason: string): void {
    this.drops++
    this.downSince = Date.now()
    this.lastError = reason
  }

  private armDeadline(): void {
    this.clearTimer()
    const timeoutMs = this.opts.attemptTimeoutMs
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.phase !== 'dialing') return
      this.fail(`no connection within ${Math.round(timeoutMs / 1000)} s`)
    }, timeoutMs)
  }

  private schedule(delayMs: number, callerPaced: boolean): void {
    this.clearTimer()
    this.phase = 'waiting'
    this.callerPaced = callerPaced
    this.nextRetryAt = Date.now() + delayMs
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.phase !== 'waiting') return
      this.dialNow()
    }, delayMs)
  }

  /** Doubling from the base, jittered ±50 % so channels that failed together do not retry together. */
  private backoff(): number {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.failures, BACKOFF_MAX_MS)
    return Math.min(Math.round(base * (0.5 + this.random())), BACKOFF_MAX_MS)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.callerPaced = false
    this.nextRetryAt = undefined
  }

  private onSignal(signal: LinkSignal): void {
    if (this.phase === 'idle' || this.phase === 'halted') return
    // A redial the caller paced (standby probing) keeps its own schedule.
    if (this.phase === 'waiting' && this.callerPaced) return
    this.redialNow(SIGNAL_REASONS[signal])
  }

  private onTick(): void {
    if (this.phase === 'online' && !this.opts.isUp()) {
      this.opts.log('warn', 'link_stall_detected', { reason: 'transport down without a close event' })
      this.fail('link went down without notice')
    }
  }
}
