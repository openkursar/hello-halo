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
  const withLoad: PerfResult = { ...result, loadAverage: os.loadavg() }
  const dir = path.join(resultsRoot, withLoad.label)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${withLoad.scenario}.json`)
  fs.writeFileSync(filePath, JSON.stringify(withLoad, null, 2))
  return filePath
}

/** `PERF_LABEL` controls which results/<label>/ directory a run writes into. */
export function currentLabel(): string {
  return process.env.PERF_LABEL || 'dev'
}

/** `PERF_THROTTLE` controls CDP CPU throttling rate; default 1 = unthrottled. */
export function currentThrottle(): number {
  const raw = process.env.PERF_THROTTLE
  const parsed = raw ? Number(raw) : 1
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}
