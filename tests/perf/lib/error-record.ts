import { writeResult, currentLabel, currentThrottle } from './result-writer'
import { getBuildIdentity } from './build-identity'
import type { PerfResult } from '../types'

/**
 * Writes the stub result a scenario leaves behind when it died before reaching
 * its own `writeResult` call.
 *
 * `skipReason` is deliberately not set. That field is for a precondition
 * detected *before* the scenario acted, drawn from a vocabulary the release
 * gate accepts; a crash mid-measurement is not an approved absence, and
 * labelling it as one is how a broken run comes to read as clean.
 */
export function writeErrorResult(scenario: string, why: string): void {
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
    status: 'error',
    note: why
  }
  writeResult(result)
}
