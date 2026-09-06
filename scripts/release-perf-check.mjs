#!/usr/bin/env node
/**
 * release-perf-check — the performance gate a release build must clear.
 *
 * One entry point so that every release script runs the identical sequence.
 * Duplicating these four steps into each script is how they drift, and a
 * release gate that differs per script is not a gate.
 *
 *   1. record the build identity, so the results can be tied to a binary
 *   2. measure the gated scenarios (the `perf-release` project)
 *   3. verify the run actually happened — a suite where nothing ran exits 0
 *   4. apply the thresholds, refusing a stale build
 *
 * Must run after `npm run build` and before packaging. That order is not
 * incidental: every threshold in this repo was measured on electron-vite output
 * (`out/main/index.mjs`), not on a packaged app, so measuring anything else
 * silently compares against numbers that describe a different artifact.
 *
 * Fixtures are generated rather than committed, so a clean checkout produces
 * them here rather than failing — but only after the manifest verifies them.
 *
 * Exit codes: 0 pass, 1 the build must not ship, 2 the check could not run.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const label = process.env.PERF_LABEL || `release-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`

const steps = [
  { name: 'generate/verify fixtures', argv: ['npx', 'tsx', 'tests/perf/fixtures/ensure.ts'] },
  { name: 'record build identity', argv: ['node', 'tests/perf/record-build.mjs'] },
  { name: 'measure gated scenarios', argv: ['npx', 'playwright', 'test', '--config', 'tests/playwright.config.ts', '--project=perf-release'] },
  { name: 'verify the run happened', argv: ['npx', 'tsx', 'tests/perf/verify-run.ts', '--set=release', label] },
  { name: 'apply thresholds', argv: ['node', 'scripts/perf-gate/index.mjs', '--results', `tests/perf/results/${label}`, '--require-fresh-build'] }
]

console.log(`release perf check — label ${label}\n`)

for (const step of steps) {
  const [cmd, ...args] = step.argv
  const started = Date.now()
  const run = spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, PERF_LABEL: label }
  })

  if (run.error) {
    console.error(`\nrelease perf check: cannot run "${step.name}": ${run.error.message}`)
    process.exit(2)
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  if (run.status !== 0) {
    console.error(`\nrelease perf check: FAILED at "${step.name}" after ${seconds}s.`)
    console.error(`Results are in tests/perf/results/${label}/ — read them before deciding anything.`)
    console.error('Adding an exemption is never an acceptable way to turn this green.')
    process.exit(1)
  }
  console.log(`\n  ok  ${step.name} (${seconds}s)\n`)
}

console.log(`release perf check: PASS (results/${label})`)
