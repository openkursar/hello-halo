#!/usr/bin/env tsx
/**
 * Makes the generated fixtures present and verified, generating them if
 * needed. Run before any perf scenario; exits non-zero if the set cannot be
 * brought into agreement with `manifest.json`.
 *
 *   npx tsx tests/perf/fixtures/ensure.ts
 */

import { execFileSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { fixturePath, manifestFixtureNames } from '../lib/fixture-store'

const here = path.dirname(fileURLToPath(import.meta.url))

function verifyAll(): string[] {
  const problems: string[] = []
  for (const name of manifestFixtureNames()) {
    try {
      fixturePath(name)
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
    }
  }
  return problems
}

let problems = verifyAll()
if (problems.length > 0) {
  console.log(`[fixtures] ${problems.length} fixture(s) missing or stale — generating.`)
  try {
    execFileSync('python3', [path.join(here, 'generate.py')], { stdio: 'inherit' })
  } catch {
    console.error('[fixtures] generate.py failed. python3 (3.8+, no third-party deps) is required.')
    process.exit(1)
  }
  problems = verifyAll()
}

if (problems.length > 0) {
  console.error(`[fixtures] FAIL — ${problems.length} fixture(s) still do not match the manifest:`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`[fixtures] OK — ${manifestFixtureNames().length} fixtures verified against manifest.json.`)
