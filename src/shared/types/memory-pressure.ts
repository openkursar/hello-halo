/**
 * Memory pressure as seen by every process. The main process derives the level
 * from its resource samples; the renderer receives it on `app:memory-pressure`.
 *
 * - normal: no action.
 * - low: shrink resident budgets (e.g. fewer resident chat sessions).
 * - critical: additionally drop what can be rebuilt on demand (hidden tab
 *   content, cached detail of conversations not on screen).
 */
export type MemoryPressureLevel = 'normal' | 'low' | 'critical'

/** Payload of the `app:memory-pressure` event and the current-level query. */
export interface MemoryPressureEvent {
  level: MemoryPressureLevel
}
