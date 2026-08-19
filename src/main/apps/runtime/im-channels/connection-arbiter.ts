/**
 * apps/runtime/im-channels -- Connection Arbiter
 *
 * Pure decision logic for IM channels whose protocol grants the bot slot to
 * the newest connection ("newest-connection-wins", e.g. WeCom Intelligent Bot).
 * When the same bot credential runs on two machines, the server repeatedly
 * kicks whichever connection is older; naive immediate reconnect turns this
 * into a tight ping-pong loop between the two devices.
 *
 * This arbiter decides — from the timing of supersede ("you were kicked because
 * a newer connection took the slot") events alone — whether to keep defending
 * the slot or to yield to a standby state, and how long to wait before the next
 * reconnect / probe attempt. It owns no timers, no sockets and no I/O, so it is
 * deterministic and unit-testable. The provider drives the actual timers and
 * connection lifecycle around these decisions.
 *
 * Resolution relies on the WeCom server being the sole arbiter (newest wins) —
 * no cross-device communication is required. Jittered backoff breaks symmetry
 * so two machines that yield at the same time do not keep probing in lockstep.
 */

/** What the provider should do after being superseded while defending the slot. */
export type SupersedeDecision = 'reconnect' | 'yield'

export interface ConnectionArbiterConfig {
  /** Sliding window (ms) over which supersede events are counted. */
  conflictWindowMs: number
  /** Supersede count within the window that flips defend → yield. */
  conflictThreshold: number
  /** Base delay (ms) for active-mode reconnect after a lone supersede. */
  reconnectBaseMs: number
  /** Cap (ms) for active-mode reconnect backoff. */
  reconnectMaxMs: number
  /** Base delay (ms) for the first standby probe after yielding. */
  probeBaseMs: number
  /** Cap (ms) for standby probe backoff. */
  probeMaxMs: number
  /**
   * Injectable randomness in [0, 1). Defaults to Math.random. Tests pass a
   * deterministic stub. Used only to jitter delays for symmetry breaking.
   */
  random?: () => number
}

/** Sensible production defaults. All durations in milliseconds. */
export const DEFAULT_ARBITER_CONFIG: ConnectionArbiterConfig = {
  conflictWindowMs: 60_000,
  conflictThreshold: 3,
  reconnectBaseMs: 2_000,
  reconnectMaxMs: 15_000,
  probeBaseMs: 5_000,
  probeMaxMs: 15 * 60_000,
}

export class ConnectionArbiter {
  private readonly cfg: ConnectionArbiterConfig
  private readonly random: () => number

  /** Epoch-ms timestamps of recent supersede events (pruned to the window). */
  private supersedes: number[] = []
  /** Consecutive active-mode reconnect attempts (for exponential backoff). */
  private reconnectAttempts = 0
  /** Consecutive standby probe attempts (for exponential backoff). */
  private probeAttempts = 0

  constructor(config: ConnectionArbiterConfig = DEFAULT_ARBITER_CONFIG) {
    this.cfg = config
    this.random = config.random ?? Math.random
  }

  /**
   * Record a supersede event and decide the response.
   *
   * Returns 'yield' once the number of supersedes within the sliding window
   * reaches the threshold (a live competitor is repeatedly taking the slot);
   * otherwise 'reconnect' (a lone supersede — the competitor may already be
   * gone, so reclaim the slot).
   */
  recordSupersede(now: number): SupersedeDecision {
    this.supersedes.push(now)
    this.prune(now)
    return this.supersedes.length >= this.cfg.conflictThreshold ? 'yield' : 'reconnect'
  }

  /**
   * Delay (ms) before the next active-mode reconnect, with exponential backoff
   * across consecutive attempts plus jitter. Increments the attempt counter.
   */
  nextReconnectDelay(): number {
    const delay = this.backoff(this.cfg.reconnectBaseMs, this.cfg.reconnectMaxMs, this.reconnectAttempts)
    this.reconnectAttempts++
    return this.jitter(delay)
  }

  /**
   * Delay (ms) before the next standby probe, with exponential backoff across
   * consecutive probe attempts plus jitter. Increments the probe counter.
   *
   * The first probe after yielding is intentionally short (probeBaseMs) so that
   * two devices which yielded simultaneously recover within seconds; heavy
   * jitter desynchronizes them so one wins the slot instead of ping-ponging.
   */
  nextProbeDelay(): number {
    const delay = this.backoff(this.cfg.probeBaseMs, this.cfg.probeMaxMs, this.probeAttempts)
    this.probeAttempts++
    return this.jitter(delay)
  }

  /**
   * Reset all counters. Called when the connection is confirmed healthy again
   * (recovered from standby, or a fresh authenticated session in active mode)
   * or when the user forces a manual takeover.
   */
  reset(): void {
    this.supersedes = []
    this.reconnectAttempts = 0
    this.probeAttempts = 0
  }

  /** Reset only the active-mode reconnect backoff (on successful auth). */
  resetReconnectBackoff(): void {
    this.reconnectAttempts = 0
  }

  /**
   * Reset only the standby probe backoff. Called when entering standby fresh
   * from a new contention episode, so the first probe fires quickly (fast
   * recovery after a simultaneous cold start); probe backoff then grows again
   * as long as a competitor keeps kicking the probes.
   */
  resetProbeBackoff(): void {
    this.probeAttempts = 0
  }

  /** Current supersede count within the window (for diagnostics/logging). */
  supersedeCount(now: number): number {
    this.prune(now)
    return this.supersedes.length
  }

  // ── Internal ───────────────────────────────────────────────────

  private prune(now: number): void {
    const cutoff = now - this.cfg.conflictWindowMs
    this.supersedes = this.supersedes.filter((ts) => ts > cutoff)
  }

  private backoff(base: number, max: number, attempt: number): number {
    // 2^attempt growth, capped. attempt 0 → base.
    const grown = base * 2 ** attempt
    return Math.min(grown, max)
  }

  private jitter(delay: number): number {
    // Scale to [0.5x, 1.5x) — enough spread to break two-device symmetry
    // without ever collapsing to zero.
    return Math.round(delay * (0.5 + this.random()))
  }
}
