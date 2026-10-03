/**
 * Renderer recovery policy — decides what the main process does when the main
 * window's renderer dies or hangs.
 *
 * A few crashes in a short window are reloaded. Past that, reloading would only
 * feed a crash loop (a renderer killed for memory comes back, reloads the same
 * state, and is killed again), so recovery halts: the window is left as is, the
 * main process and every background digital human keep running, and the user
 * decides when to restart. Halting is sticky for the life of the process.
 *
 * A hung renderer is not a crash: it is reloaded without spending the crash
 * budget, and ignored like everything else once recovery has halted.
 *
 * Pure state machine (no Electron) so the policy is testable on its own; the
 * side effects live in the main entry and services/lifecycle.
 */

/** Why the renderer went away, grouped by what recovery should assume. */
export type RendererGoneClass = 'memory' | 'crash' | 'exit'

/**
 * Electron `render-process-gone` reasons that point at memory exhaustion: an OOM,
 * an eviction, an external kill (the OS OOM killer / jetsam), or a renderer that
 * could not even start.
 */
const MEMORY_REASONS = new Set(['oom', 'memory-eviction', 'killed', 'launch-failed'])

export function classifyRendererGone(reason: string): RendererGoneClass {
  if (MEMORY_REASONS.has(reason)) return 'memory'
  if (reason === 'clean-exit') return 'exit'
  return 'crash'
}

export interface RendererRecoveryDecision {
  action: 'reload' | 'halt' | 'ignore'
  /** Crashes counted in the current window, including this one. */
  attempt: number
}

export interface RendererRecoveryOptions {
  windowMs?: number
  maxReloadsPerWindow?: number
}

export const RENDERER_RECOVERY_WINDOW_MS = 60_000
export const RENDERER_MAX_RELOADS_PER_WINDOW = 3

export class RendererRecoveryPolicy {
  private readonly windowMs: number
  private readonly maxReloads: number
  private windowStart = 0
  private attempts = 0
  private halted = false

  constructor(options: RendererRecoveryOptions = {}) {
    this.windowMs = options.windowMs ?? RENDERER_RECOVERY_WINDOW_MS
    this.maxReloads = options.maxReloadsPerWindow ?? RENDERER_MAX_RELOADS_PER_WINDOW
  }

  /** A hung renderer: reload unless recovery has halted. Never counts as a crash. */
  recordHang(): RendererRecoveryDecision {
    return { action: this.halted ? 'ignore' : 'reload', attempt: this.attempts }
  }

  /** Record one renderer crash at `now` and decide the response. */
  record(now: number): RendererRecoveryDecision {
    if (this.halted) return { action: 'ignore', attempt: this.attempts }

    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now
      this.attempts = 0
    }
    this.attempts += 1

    if (this.attempts > this.maxReloads) {
      this.halted = true
      return { action: 'halt', attempt: this.attempts }
    }
    return { action: 'reload', attempt: this.attempts }
  }

  isHalted(): boolean {
    return this.halted
  }
}
