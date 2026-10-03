/**
 * platform/background/memory-pressure -- memory pressure level for the process.
 *
 * Input: one reading per resource sample, pushed by the health sampler (the
 * only producer of resource numbers). Output: `normal | low | critical`, read
 * with `getMemoryPressure()` or followed with `onMemoryPressure(cb)`.
 *
 * Triggers are memory only — never platform or VDI detection:
 *
 *   level     available system memory     or   main-window renderer memory
 *   low       < 15 % of total                   > 1 GB
 *   critical  <  7 % of total                   > 1.5 GB
 *
 * "Available" means memory the OS can hand out without swapping, per platform:
 *
 *   platform  source                                    note
 *   macOS     `sysctl kern.memorystatus_level`          kernel free %, as `memory_pressure` reports;
 *                                                       os.freemem() counts only free pages and reads
 *                                                       single digits on a healthy Mac
 *   Linux     os.freemem()                              libuv reads MemAvailable
 *   Windows   os.freemem()                              ullAvailPhys
 *
 * When the macOS kernel reading fails, the sampler falls back to os.freemem()
 * and marks the reading `fallback`. A fallback reading alone cannot raise the
 * level; it counts only after three consecutive fallback samples.
 *
 * Escalation is immediate; de-escalation needs three consecutive samples below
 * the current level, and then settles on the highest level seen among them.
 *
 * Two levels are kept. `getMemoryPressure()` counts both triggers, for memory
 * the renderer itself holds (canvas tabs, cached conversations).
 * `getSystemMemoryPressure()` counts available system memory only, for budgets
 * whose release does not shrink the renderer (resident engine sessions): a
 * heavy window would otherwise keep that budget lowered without relief.
 */

import type { MemoryPressureLevel } from '../../../shared/types/memory-pressure'

export type { MemoryPressureLevel }

export interface MemoryReading {
  /** Available / total system memory in [0, 1]; null when unknown. */
  availableRatio: number | null
  availableSource: 'kernel' | 'os' | 'fallback'
  /** Main-window renderer memory in MB (private bytes where the OS reports them). */
  rendererMb: number | null
}

export const LOW_AVAILABLE_RATIO = 0.15
export const CRITICAL_AVAILABLE_RATIO = 0.07
export const LOW_RENDERER_MB = 1024
export const CRITICAL_RENDERER_MB = 1536
export const RECOVERY_SAMPLES = 3
export const FALLBACK_TRUST_SAMPLES = 3

const RANK: Record<MemoryPressureLevel, number> = { normal: 0, low: 1, critical: 2 }

function levelOfRatio(ratio: number | null): MemoryPressureLevel {
  if (ratio === null) return 'normal'
  if (ratio < CRITICAL_AVAILABLE_RATIO) return 'critical'
  if (ratio < LOW_AVAILABLE_RATIO) return 'low'
  return 'normal'
}

function levelOfRenderer(mb: number | null): MemoryPressureLevel {
  if (mb === null) return 'normal'
  if (mb > CRITICAL_RENDERER_MB) return 'critical'
  if (mb > LOW_RENDERER_MB) return 'low'
  return 'normal'
}

function higher(a: MemoryPressureLevel, b: MemoryPressureLevel): MemoryPressureLevel {
  return RANK[a] >= RANK[b] ? a : b
}

export class MemoryPressureTracker {
  private level: MemoryPressureLevel = 'normal'
  private belowStreak = 0
  private belowStreakMax: MemoryPressureLevel = 'normal'
  private fallbackStreak = 0

  constructor(private readonly countRenderer = true) {}

  get current(): MemoryPressureLevel {
    return this.level
  }

  /** Level this reading alone indicates, after the fallback rule. */
  classify(reading: MemoryReading): MemoryPressureLevel {
    this.fallbackStreak = reading.availableSource === 'fallback' ? this.fallbackStreak + 1 : 0
    const trustRatio = reading.availableSource !== 'fallback' || this.fallbackStreak >= FALLBACK_TRUST_SAMPLES
    const byRatio = trustRatio ? levelOfRatio(reading.availableRatio) : 'normal'
    return this.countRenderer ? higher(byRatio, levelOfRenderer(reading.rendererMb)) : byRatio
  }

  /** Feed one reading; returns the resulting level. */
  evaluate(reading: MemoryReading): MemoryPressureLevel {
    const raw = this.classify(reading)
    if (RANK[raw] > RANK[this.level]) {
      this.level = raw
      this.belowStreak = 0
    } else if (RANK[raw] < RANK[this.level]) {
      this.belowStreakMax = this.belowStreak === 0 ? raw : higher(this.belowStreakMax, raw)
      this.belowStreak += 1
      if (this.belowStreak >= RECOVERY_SAMPLES) {
        this.level = this.belowStreakMax
        this.belowStreak = 0
      }
    } else {
      this.belowStreak = 0
    }
    return this.level
  }
}

// ── Process-wide instance ──────────────────────────────────────────────

type PressureListener = (level: MemoryPressureLevel, previous: MemoryPressureLevel) => void

const tracker = new MemoryPressureTracker()
const listeners = new Set<PressureListener>()
const systemTracker = new MemoryPressureTracker(false)
const systemListeners = new Set<PressureListener>()

function subscribe(set: Set<PressureListener>, listener: PressureListener): () => void {
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

function notify(set: Set<PressureListener>, level: MemoryPressureLevel, previous: MemoryPressureLevel): void {
  for (const listener of set) {
    try {
      listener(level, previous)
    } catch (error) {
      console.error('[MemoryPressure] Listener failed:', error)
    }
  }
}

export function getMemoryPressure(): MemoryPressureLevel {
  return tracker.current
}

/** Called with (level, previous) on every level change. Returns an unsubscribe. */
export function onMemoryPressure(listener: PressureListener): () => void {
  return subscribe(listeners, listener)
}

/** The level from available system memory alone (see the header). */
export function getSystemMemoryPressure(): MemoryPressureLevel {
  return systemTracker.current
}

/** Called with (level, previous) on every system-memory level change. Returns an unsubscribe. */
export function onSystemMemoryPressure(listener: PressureListener): () => void {
  return subscribe(systemListeners, listener)
}

/**
 * Feed one reading from the resource sampler. Only the health sampler calls
 * this — it is the single source of resource numbers.
 */
export function evaluateMemoryPressure(reading: MemoryReading): MemoryPressureLevel {
  const previousSystem = systemTracker.current
  const systemLevel = systemTracker.evaluate(reading)
  const previous = tracker.current
  const level = tracker.evaluate(reading)
  if (level !== previous || systemLevel !== previousSystem) {
    const ratio = reading.availableRatio === null ? 'n/a' : `${Math.round(reading.availableRatio * 100)}%`
    console.warn(
      `[MemoryPressure] ${previous} -> ${level}, system ${previousSystem} -> ${systemLevel} ` +
      `(available=${ratio} source=${reading.availableSource} ` +
      `renderer=${reading.rendererMb === null ? 'n/a' : `${Math.round(reading.rendererMb)}MB`})`
    )
  }
  if (systemLevel !== previousSystem) notify(systemListeners, systemLevel, previousSystem)
  if (level !== previous) notify(listeners, level, previous)
  return level
}
