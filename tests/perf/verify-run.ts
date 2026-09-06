#!/usr/bin/env tsx
/**
 * Decides whether a completed perf run is trustworthy.
 *
 *   npx tsx tests/perf/verify-run.ts [label]        # default label: $PERF_LABEL or "dev"
 *
 * Playwright exits 0 for a run in which every scenario skipped, and a scenario
 * that hangs hard enough to blow its own test timeout writes no file at all.
 * Both look exactly like a clean run to anything watching only the exit code,
 * so this reads the results directory itself and states what actually ran.
 *
 * Expected scenarios are listed explicitly rather than inferred from whatever
 * happens to be on disk — inferring makes a missing scenario undetectable by
 * construction, which is the failure this exists to catch.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { PerfResult } from './types'

const resultsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'results')

/**
 * What each Playwright project is expected to leave behind. A release build runs
 * only the gated subset, so checking it against the full list would report seven
 * scenarios missing on every release — and a check that is always red is a check
 * people learn to ignore.
 */
const EXPECTED_BY_SET: Record<string, string[]> = {
  full: [
    's1-cold-start',
    's2-long-stream',
    's3-long-list-scroll',
    's4-markdown-preview',
    's5-file-preview',
    's6-preview-plus-chat',
    's7a-terminal-streaming',
    's7b-browser-view',
    's8-digital-human-run'
  ],
  // Mirrors the `perf-release` project. The threshold check that follows names
  // each scenario it needs, so this list only has to cover what that project
  // runs; `s5-file-preview` stands for the per-content-type files.
  release: ['s4-markdown-preview', 's5-file-preview']
}

/**
 * Scenarios allowed to be absent. `s5-file-preview` writes one file per content
 * type rather than one under its own name; the two soaks live in the
 * `perf-soak` project and are not part of a standard run, so requiring them
 * would make every ordinary run report a missing scenario — a check that is
 * always red is a check people learn to ignore.
 */
const OPTIONAL = new Set(['s5-file-preview', 's9-soak', 's9-soak-probe', 's10-csv-crash-loop'])

const args = process.argv.slice(2)
const setArg = args.find((a) => a.startsWith('--set='))?.slice('--set='.length) ?? 'full'
const EXPECTED = EXPECTED_BY_SET[setArg]
if (!EXPECTED) {
  console.log(`FAIL — unknown --set=${setArg}; expected one of ${Object.keys(EXPECTED_BY_SET).join(', ')}`)
  process.exit(1)
}

const label = args.find((a) => !a.startsWith('--')) || process.env.PERF_LABEL || 'dev'
const dir = path.join(resultsRoot, label)

const failures: string[] = []

/** Notes carry multi-line call logs; the full text is in the JSON. */
const oneLine = (s: string | undefined): string => (s ? s.split('\n')[0].slice(0, 160) : '')

if (!fs.existsSync(dir)) {
  console.log(`FAIL — no results directory at ${dir}`)
  console.log('       Nothing ran, or PERF_LABEL did not match the label the run wrote under.')
  process.exit(1)
}

const results: PerfResult[] = []
// S10 records a timeline rather than a before/after measurement and writes its
// own shape. Judging it by `valid` — a field it does not have — reported it as
// contaminated on every run. Detected by shape rather than by name so the next
// scenario with its own schema does not reintroduce the false failure.
const nonStandard: string[] = []
for (const name of fs.readdirSync(dir).sort()) {
  if (!name.endsWith('.json')) continue
  const full = path.join(dir, name)
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
    if (typeof parsed.valid === 'boolean') results.push(parsed)
    else nonStandard.push(parsed.scenario ?? name)
  } catch (err) {
    failures.push(`${name} is not readable JSON (${err instanceof Error ? err.message : String(err)})`)
  }
}

if (results.length === 0) {
  console.log(
    nonStandard.length > 0
      ? `FAIL — ${dir} holds only scenarios with their own schema (${nonStandard.join(', ')}); nothing here can be verified`
      : `FAIL — ${dir} contains no result files`
  )
  process.exit(1)
}

const present = new Set(results.map((r) => r.scenario))
// s5 writes per-content-type files; treat any of them as covering it.
const s5Present = results.some((r) => r.scenario.startsWith('s5-'))

console.log(
  `[1] ${results.length} result file(s) under results/${label}/` +
  (nonStandard.length > 0 ? ` (+${nonStandard.length} with their own schema, not judged here: ${nonStandard.join(', ')})` : '')
)

const missing = EXPECTED.filter((s) => {
  if (present.has(s)) return false
  if (s === 's5-file-preview' && s5Present) return false
  return !OPTIONAL.has(s)
})
if (missing.length > 0) {
  console.log(`[2] missing scenarios: ${missing.join(', ')}`)
  failures.push(`${missing.length} expected scenario(s) produced no result file — a scenario that hangs past its test timeout writes nothing`)
} else {
  console.log('[2] every expected scenario produced a result file')
}

const skipped = results.filter((r) => r.status === 'skipped')
console.log(`[3] ${skipped.length} scenario(s) recorded as skipped`)
for (const r of skipped) {
  console.log(`      ${r.scenario}  reason=${r.skipReason ?? '(unrecorded)'}  ${oneLine(r.note)}`)
}
if (skipped.length > 0) {
  failures.push(`${skipped.length} scenario(s) did not execute (unmet precondition: ${[...new Set(skipped.map((r) => r.skipReason ?? 'unrecorded'))].join(', ')})`)
}

const notOk = results.filter((r) => r.status !== 'skipped' && r.status !== undefined && r.status !== 'ok')
console.log(`[4] ${notOk.length} scenario(s) finished with a non-ok status`)
for (const r of notOk) console.log(`      ${r.scenario}  status=${r.status}  ${oneLine(r.note)}`)
if (notOk.length > 0) failures.push(`${notOk.length} scenario(s) did not complete cleanly (${notOk.map((r) => `${r.scenario}=${r.status}`).join(', ')})`)

const invalid = results.filter((r) => r.status !== 'skipped' && !r.valid)
if (invalid.length > 0) {
  console.log(`[5] ${invalid.length} scenario(s) marked valid:false — contaminated by a renderer reload/crash, or the action never completed`)
  for (const r of invalid) console.log(`      ${r.scenario}  reloads=${r.rendererReloads} crashes=${r.crashCount}`)
  failures.push(`${invalid.length} scenario(s) produced numbers that are not trustworthy (valid:false)`)
} else {
  console.log(`[5] all ${results.length - skipped.length} executed scenario(s) are valid:true`)
}

// A number is only comparable if we know which artifact produced it. Without
// the build sidecar the identity falls back to live HEAD, which may not be
// what the measured binary was built from at all.
const unverified = results.filter((r) => r.build && !r.build.verified)
const dirty = results.filter((r) => r.build?.dirty)
const noKind = results.filter((r) => r.build && r.build.artifactKind === null)
console.log(`[6] build identity: ${unverified.length} unverified, ${dirty.length} from a dirty tree, ${noKind.length} with unknown artifact kind`)
if (unverified.length > 0) failures.push(`${unverified.length} result(s) carry an unverified build identity — run \`node tests/perf/record-build.mjs\` right after building, before measuring`)
if (noKind.length > 0) failures.push(`${noKind.length} result(s) do not record which artifact kind was measured — electron-vite output and a packaged app are not comparable`)
if (dirty.length > 0) {
  // A dirty tree means the results cannot be tied to a commit, which sinks them
  // as a baseline for a future comparison but says nothing about whether this
  // build is fast enough. The release scripts bump the version before measuring
  // and commit it afterwards, so a release run is dirty by construction —
  // failing on it would make this check red on every release, which is how a
  // check stops being read.
  const message = `${dirty.length} result(s) were measured from a dirty working tree`
  if (setArg === 'release') console.log(`      note: ${message} — expected during a release (version bump not yet committed); not comparable as a baseline`)
  else failures.push(message)
}

// Results from one run agree on their AI source, so disagreement proves the
// directory holds more than one. It does not prove the converse — two runs
// against the same source merge undetected — but a mock/external mix is the
// case that silently makes half the numbers incomparable. Results written
// before this field existed read as `unrecorded`, a single value, so a frozen
// baseline still verifies clean.
const sources = [...new Set(results.map((r) => r.aiSource ?? 'unrecorded'))].sort()
console.log(`[7] AI source: ${sources.join(', ')}`)
if (sources.length > 1) {
  failures.push(`results/${label}/ mixes AI sources (${sources.join(', ')}) — these files are not one run, so nothing in here can be compared`)
}
if (sources.includes('external')) {
  console.log('      note: an external source streams a different token count and timing every run — those scenarios are not a baseline')
}

console.log()
if (failures.length === 0) {
  console.log(`PASS — results/${label}/ is a complete, trustworthy run`)
} else {
  console.log(`FAIL — ${failures.length}:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
