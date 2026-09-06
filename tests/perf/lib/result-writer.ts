import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { PerfResult } from '../types'

const __filename = fileURLToPath(import.meta.url)
const resultsRoot = path.resolve(path.dirname(__filename), '../results')

/**
 * Every result carries the machine's load average at write time, so a number
 * can't be read without also seeing how busy the machine was — S4 alone swung
 * 8.5s -> 23s max-longtask across two identical runs purely from other
 * processes competing for the CPU.
 * Injected centrally here (every scenario already ends by calling
 * `writeResult`) instead of copy-pasted into every spec file.
 */
export function writeResult(result: PerfResult): string {
  const withLoad: PerfResult = { ...result, loadAverage: os.loadavg(), aiSource: currentAiSource() }
  const filePath = resultPath(withLoad.label, withLoad.scenario)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(withLoad, null, 2))
  clearInFlightMarker(withLoad.label, withLoad.scenario)
  return filePath
}

/** Where a scenario's result lands. */
export function resultPath(label: string, scenario: string): string {
  return path.join(resultsRoot, label, `${scenario}.json`)
}

/** Where a scenario's "I started" marker lives while it runs. */
export function inFlightDir(label: string): string {
  return path.join(resultsRoot, label, '.in-flight')
}

/**
 * Announces that a scenario has started, so that dying before `writeResult` is
 * distinguishable from never having been scheduled.
 *
 * On disk rather than in a module variable because the sweeper runs in the
 * runner process (`tests/perf/reporter/in-flight.ts`), which outlives a worker
 * crash that would take any in-memory registry with it.
 */
export function beginScenario(scenario: string): void {
  const dir = inFlightDir(currentLabel())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${scenario}.json`),
    JSON.stringify({ scenario, startedAt: new Date().toISOString() }, null, 2)
  )
}

function clearInFlightMarker(label: string, scenario: string): void {
  fs.rmSync(path.join(inFlightDir(label), `${scenario}.json`), { force: true })
}

/** `PERF_LABEL` controls which results/<label>/ directory a run writes into. */
export function currentLabel(): string {
  return process.env.PERF_LABEL || 'dev'
}

/**
 * Which AI source this process is configured against. Only the perf runner can
 * claim `'mock'` — it is the one thing that knows it started the mock and
 * overrode the env; a key that came from anywhere else is `'external'` even if
 * it happens to point at localhost, because nothing here verified that.
 */
export function currentAiSource(): 'mock' | 'external' | 'none' {
  if (process.env.PERF_AI_SOURCE === 'mock') return 'mock'
  return process.env.HALO_TEST_API_KEY ? 'external' : 'none'
}

/** `PERF_THROTTLE` controls CDP CPU throttling rate; default 1 = unthrottled. */
export function currentThrottle(): number {
  const raw = process.env.PERF_THROTTLE
  const parsed = raw ? Number(raw) : 1
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}
