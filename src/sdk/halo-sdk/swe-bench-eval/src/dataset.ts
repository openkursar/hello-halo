/**
 * Dataset loading utilities for SWE-Bench Verified instances.
 */

import { readFileSync, existsSync } from 'fs'
import type { SWEBenchInstance } from './types.ts'

export function loadDataset(datasetPath: string): SWEBenchInstance[] {
  if (!existsSync(datasetPath)) {
    throw new Error(
      `Dataset not found at ${datasetPath}\n` +
      `Run: python3 scripts/load-dataset.py to download it`
    )
  }
  const lines = readFileSync(datasetPath, 'utf-8').split('\n').filter(Boolean)
  return lines.map(line => JSON.parse(line) as SWEBenchInstance)
}

export function filterInstances(
  instances: SWEBenchInstance[],
  opts: { instanceIds?: string[]; limit?: number }
): SWEBenchInstance[] {
  let filtered = instances
  if (opts.instanceIds?.length) {
    const ids = new Set(opts.instanceIds)
    filtered = filtered.filter(i => ids.has(i.instance_id))
  }
  if (opts.limit) {
    filtered = filtered.slice(0, opts.limit)
  }
  return filtered
}
