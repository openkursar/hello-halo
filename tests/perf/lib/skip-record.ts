import { writeResult, currentLabel, currentThrottle } from './result-writer'
import { getBuildIdentity } from './build-identity'
import type { PerfResult } from '../types'

/**
 * Writes the stub result a scenario leaves behind when its precondition is not
 * met. Playwright reports a skipped test as green, so this record is the only
 * trace a gate can see: `verify-run.ts` counts these and refuses to call a run
 * clean when scenarios did not execute.
 *
 * `reason` must come from the vocabulary registered in `ALLOWED_SKIPS`
 * (scripts/perf-gate/thresholds.mjs) — the gate rejects any other value, which
 * is what keeps the two sides on one vocabulary. `how` is for the human
 * reading the file.
 */
export function writeSkipResult(scenario: string, reason: string, how: string): void {
  const result: PerfResult = {
    scenario,
    label: currentLabel(),
    build: getBuildIdentity(),
    throttle: currentThrottle(),
    durationMs: 0,
    cpu: { byProcessType: {} },
    mem: { byProcessType: {} },
    sampling: { plannedTicks: 0, succeededTicks: 0 },
    longtask: null,
    eventLatency: null,
    heap: { startMB: 0, endMB: null, deltaMB: null },
    nodes: { start: 0, end: null, delta: null },
    listeners: { start: 0, end: null, delta: null },
    unresponsiveCount: 0,
    rendererReloads: 0,
    crashCount: 0,
    valid: false,
    status: 'skipped',
    skipReason: reason,
    note: how
  }
  writeResult(result)
}
