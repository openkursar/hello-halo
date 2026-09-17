#!/usr/bin/env node
/**
 * precommit-gate.mjs — the checks a commit must clear, selected by what it touched.
 *
 * ## The rule that matters most when this gate fails
 *
 * **Adding an entry to a skip list is never an acceptable way to turn a failing
 * check green.** Fix the code or fix the criterion. Every list in this file that
 * names a file or a path records something about the repository that is true
 * regardless of your change; none of them exist to let a change through.
 *
 * ## Why a script and not prose in the skill
 *
 * The `code-commit` skill invokes this with one command. If the checks lived in
 * the skill as instructions, the set that actually ran would depend on how an
 * agent read them that day. Here the selection is a function of `git status`.
 *
 * ## Why not a git hook
 *
 * A hook is bypassed with `--no-verify`, and every commit in this repo is made
 * by an agent running the skill anyway. The skill is the real chokepoint.
 *
 * ## What this gate does NOT check
 *
 * - **Runtime performance.** Nothing here launches Electron; the numbers the
 *   perf report is built on take 12-18 minutes to reproduce. This gate verifies
 *   the *gate* still works (`perf:gate:self-test`) and that the markdown chunker
 *   still splits the way the measured build split. Actual DOM node counts are
 *   the release gate's job.
 * - **Windows.** Every check here runs on the committer's machine, and this is a
 *   macOS-only team. Both release scripts produce Windows packages and there is
 *   zero Windows data behind any threshold in this repo.
 * - **Type errors your change caused in files it did not touch.** See
 *   scripts/typecheck-changed.mjs.
 *
 * Usage:
 *   node scripts/precommit-gate.mjs            # scope from git status
 *   node scripts/precommit-gate.mjs a.ts b.tsx # explicit paths
 *
 * Exit codes: 0 pass, 1 a check failed, 2 the gate could not run.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/**
 * Paths whose behaviour the perf round actually changed. Touching one of these
 * pulls in the chunker guards, which are the portable half of the corpus check:
 * they need only the tracked fixtures, so they pass on a fresh clone.
 */
const VIEWER_PATHS = [
  /^src\/renderer\/lib\/markdown-chunks\.ts$/,
  /^src\/renderer\/components\/canvas\/viewers\//,
  /^src\/renderer\/components\/chat\/tool-result\//,
  /^tests\/perf\/checks\//
]

/** Touching the gate's own policy or runner re-runs its self-test regardless. */
const GATE_PATHS = [/^scripts\/perf-gate\//, /^tests\/perf\//]

/**
 * The local macOS build path. Its tests are node:test rather than vitest, so
 * the unit-test scoping below cannot reach them.
 */
const MAC_BUILD_PATHS = [
  /^scripts\/(build|install)-mac-local\.cjs$/,
  /^scripts\/lib\/mac-local-signing\.cjs$/,
  /^tests\/check\/mac-local-signing\.test\.cjs$/
]

/**
 * Unit tests that do not pass on a clean checkout, and so cannot be part of any
 * gate: a check that is always red is a check people learn to ignore. Recorded
 * with the reason rather than silently dropped, so that fixing the cause also
 * removes the entry.
 */
const UNGATEABLE_TESTS = {
  'tests/unit/apps/runtime/federation/gateway-interop.test.ts':
    'drives the real Go relay binary; reported flaky, and 23s even when it passes'
}

/**
 * Same runner as `npm run test:unit`. Plain `npx vitest` loads better-sqlite3,
 * which is built against Electron's ABI, and dies with ERR_DLOPEN_FAILED —
 * a real binary mismatch that reads exactly like a broken test.
 */
const UNIT_RUNNER = [
  'npx',
  'cross-env',
  'ELECTRON_RUN_AS_NODE=1',
  'electron',
  'node_modules/vitest/vitest.mjs',
  'run',
  '--config',
  'tests/vitest.config.ts'
]

function changedPaths() {
  const explicit = process.argv.slice(2)
  if (explicit.length > 0) return explicit

  const out = execFileSync('git', ['status', '--porcelain'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8'
  })
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((path) => (path.includes(' -> ') ? path.split(' -> ')[1] : path))
    .map((path) => path.replace(/^"|"$/g, ''))
}

/**
 * A changed source file's unit test is the one named after it. Derived rather
 * than listed so the mapping cannot go stale; vitest 1.6 has no `--related`.
 */
function scopedUnitTests(changed) {
  const candidates = new Set()
  for (const path of changed) {
    if (/^tests\/unit\/.*\.test\.tsx?$/.test(path)) {
      candidates.add(path)
      continue
    }
    const match = /^src\/(.+)\.tsx?$/.exec(path)
    if (!match) continue
    for (const ext of ['ts', 'tsx']) {
      const test = `tests/unit/${match[1]}.test.${ext}`
      if (existsSync(resolve(PROJECT_ROOT, test))) candidates.add(test)
    }
  }
  return {
    tests: [...candidates].filter((test) => !(test in UNGATEABLE_TESTS)),
    excluded: [...candidates].filter((test) => test in UNGATEABLE_TESTS)
  }
}

const changed = changedPaths()
if (changed.length === 0) {
  // Not a pass. Nothing was inspected, and a gate that reports PASS on an empty
  // scope teaches people that PASS means "I ran".
  console.error('precommit gate: nothing changed — there is nothing to commit.')
  process.exit(2)
}

const touched = (patterns) => changed.some((p) => patterns.some((re) => re.test(p)))

const checks = [
  {
    name: 'typecheck (changed files)',
    // Passed explicitly rather than letting it re-derive: otherwise a run given
    // paths on the command line would typecheck whatever git status happened to
    // say, and report a scope it never looked at.
    argv: ['node', 'scripts/typecheck-changed.mjs', ...changed]
  },
  {
    name: 'perf gate self-test',
    argv: ['node', 'scripts/perf-gate/index.mjs', '--self-test'],
    when: touched([...VIEWER_PATHS, ...GATE_PATHS])
  },
  {
    name: 'perf fixtures match manifest',
    argv: ['npx', 'tsx', 'tests/perf/fixtures/ensure.ts'],
    when: touched(VIEWER_PATHS)
  },
  {
    name: 'markdown chunking guards',
    argv: ['npx', 'tsx', 'tests/perf/checks/markdown-chunking-guards.ts'],
    when: touched(VIEWER_PATHS)
  },
  {
    name: 'local macOS signing',
    argv: ['node', '--test', 'tests/check/mac-local-signing.test.cjs'],
    when: touched(MAC_BUILD_PATHS)
  }
]

const { tests: unitTests, excluded: ungateable } = scopedUnitTests(changed)
if (unitTests.length > 0) {
  checks.push({
    name: `unit tests (${unitTests.length} file(s) for changed sources)`,
    argv: [...UNIT_RUNNER, ...unitTests]
  })
}

const selected = checks.filter((check) => check.when !== false)
console.log(`precommit gate — ${changed.length} changed path(s), ${selected.length} check(s)\n`)

let failed = false
for (const check of selected) {
  const [cmd, ...args] = check.argv
  const started = Date.now()
  // Default maxBuffer is 1 MB, and a check's output scales with how much the
  // commit touched. A whole-branch commit made tsc overflow it, and spawnSync
  // reports that as ENOBUFS — a gate that crashes on large commits is a gate
  // that gets bypassed on exactly the commits that most need checking.
  const run = spawnSync(cmd, args, { cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })

  if (run.error) {
    console.error(`CANNOT RUN  ${check.name}: ${run.error.message}`)
    process.exit(2)
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (run.status === 0) {
    console.log(`  ok    ${check.name}  (${seconds}s)`)
    continue
  }

  failed = true
  console.error(`  FAIL  ${check.name}  (${seconds}s)`)
  const output = `${run.stdout}${run.stderr}`.trimEnd()
  for (const line of output.split('\n')) console.error(`        ${line}`)
}

if (ungateable.length > 0) {
  console.log('\nNot run — your change selected these, but they do not pass on a clean checkout:')
  for (const test of ungateable) console.log(`  ${test}: ${UNGATEABLE_TESTS[test]}`)
  console.log('Run them by hand and read the result yourself.')
}

if (failed) {
  console.error('\nCommit blocked. Fix the code or fix the criterion — not the check list.')
  process.exit(1)
}

console.log('\nPASS')
