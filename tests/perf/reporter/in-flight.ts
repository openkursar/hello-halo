/**
 * Writes a `status: 'error'` record for any scenario that started and never
 * produced a result, so that dying is distinguishable from never having run.
 *
 * It lives in the runner process rather than in a fixture because the failures
 * worth catching are the ones that take the worker down with them, and because
 * the perf specs share no single `test` object to hang a teardown on — most
 * launch their own app and import Playwright's directly.
 */

import fs from 'fs'
import path from 'path'
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter'
import { currentLabel, inFlightDir, resultPath } from '../lib/result-writer'
import { writeErrorResult } from '../lib/error-record'

function writtenSince(filePath: string, startedAt: number): boolean {
  try {
    return fs.statSync(filePath).mtimeMs >= startedAt
  } catch {
    return false
  }
}

export default class InFlightReporter implements Reporter {
  /** Set at construction, before any worker starts. Assigning this in a hook risks leaving it at 0, and a 0 would sweep every stale marker on disk. */
  private readonly runStartedAt = Date.now()

  onTestEnd(test: TestCase, result: TestResult): void {
    // With `workers: 1` at most one scenario is in flight, so the failing test
    // named here is the one that abandoned the marker. Under parallel workers
    // the scenario id stays right and only this attribution would blur.
    const why = result.error
      ? `${result.status} in "${test.title}": ${result.error.message ?? 'no message'}`
      : `test "${test.title}" reported ${result.status} without the scenario writing its result`
    this.sweep(why)
  }

  onEnd(result: FullResult): void {
    this.sweep(`the run ended (${result.status}) before this scenario wrote its result`)
  }

  private sweep(why: string): void {
    const label = currentLabel()
    const dir = inFlightDir(label)
    if (!fs.existsSync(dir)) return

    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const markerPath = path.join(dir, name)
      const scenario = name.slice(0, -'.json'.length)

      let startedAt = 0
      try {
        startedAt = Date.parse(JSON.parse(fs.readFileSync(markerPath, 'utf8')).startedAt)
      } catch {
        continue // Unreadable marker: cannot prove it belongs to this run, so leave it alone.
      }
      // `PERF_LABEL` defaults to `dev` for every project in this config, so
      // without this an e2e run would sweep the leftovers of an aborted perf
      // run and invent failures for scenarios it never scheduled.
      if (!(startedAt >= this.runStartedAt)) continue

      // Scenarios with their own schema (the soaks, S10) write their file
      // directly rather than through `writeResult`, so a marker outlives a good
      // run. Freshness rather than mere existence: re-running one scenario into
      // a directory that already holds an older result would otherwise let the
      // failure pass unrecorded.
      if (!writtenSince(resultPath(label, scenario), startedAt)) {
        writeErrorResult(scenario, why)
        console.log(`[perf] ${scenario} produced no result; recorded status=error — ${why.split('\n')[0]}`)
      }
      fs.rmSync(markerPath, { force: true })
    }
    if (fs.readdirSync(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true })
  }
}
