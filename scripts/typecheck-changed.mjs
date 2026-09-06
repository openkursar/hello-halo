#!/usr/bin/env node
/**
 * typecheck-changed.mjs — typecheck the project, report only the files you touched.
 *
 * The repository does not currently typecheck clean: the node project reports
 * ~112 pre-existing errors and the renderer ~400, the bulk of the latter from a
 * single missing `window.halo` declaration. Gating on a zero baseline would
 * therefore mean either fixing all of that first or maintaining a list of known
 * errors — and a known-errors list is a whitelist by another name: it goes
 * stale, and the way people make it green is by adding to it.
 *
 * Scoping to changed files instead needs no baseline and no upkeep. It is
 * derived from git, so it cleans itself up.
 *
 * This is not theoretical. A recent main-process change set
 * `log.transports.file.writeAsync`, a property that does not exist in
 * electron-log v5 — the whole change silently did nothing. tsc reported it as
 * TS2339 in two of that commit's own changed files, where this script would
 * have surfaced it, but it was buried among 130 phantom downlevel-iteration
 * errors nobody was reading.
 *
 * Known limitation: a change in file A can introduce an error in an untouched
 * file B, and filtering by changed files will not show it. Stated rather than
 * left to be discovered.
 *
 * Usage:
 *   node scripts/typecheck-changed.mjs                 # files changed vs HEAD
 *   node scripts/typecheck-changed.mjs src/a.ts ...    # explicit files
 *
 * Exit codes:
 *   0 — no type errors in the changed files
 *   1 — type errors found in the changed files
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

/**
 * `composite` makes tsc consult the tsbuildinfo under `out/`, which is written
 * by the build and can be arbitrarily old. A stale one replays the errors of
 * whatever was compiled last: with it in place this project reported 47
 * downlevel-iteration errors that its `target` had already made impossible.
 * A verification tool must not read a cache it does not control. Turning it off
 * also drops TS6307, a composite-only bookkeeping diagnostic about untracked
 * .json imports that says nothing about type safety.
 */
const NO_CACHE = ['--composite', 'false', '--incremental', 'false']

const PROJECTS = [
  { config: 'tsconfig.node.json', owns: (f) => /^src\/(main|preload|shared|worker)\//.test(f) },
  { config: 'tsconfig.web.json', owns: (f) => /^src\/(renderer|shared)\//.test(f) },
  // Playwright and vitest transpile without typechecking, so nothing else ever
  // reads these files as types. The perf harness produces every number this
  // repo's performance claims rest on.
  { config: 'tsconfig.test.json', owns: (f) => /^tests\//.test(f) }
]

function changedFiles() {
  const explicit = process.argv.slice(2)
  if (explicit.length > 0) return explicit

  const out = execFileSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf-8' })
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    // Renames read as "old -> new"; only the new path can have errors.
    .map((path) => (path.includes(' -> ') ? path.split(' -> ')[1] : path))
    .map((path) => path.replace(/^"|"$/g, ''))
}

const changed = changedFiles().filter((f) => /\.(tsx?|mts)$/.test(f) && /^(src|tests)\//.test(f))

if (changed.length === 0) {
  console.log('typecheck: no changed TypeScript sources under src/ or tests/')
  process.exit(0)
}

let failed = false
for (const { config, owns } of PROJECTS) {
  const mine = changed.filter(owns)
  if (mine.length === 0) continue

  const run = spawnSync('npx', ['tsc', '--noEmit', '-p', config, ...NO_CACHE], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    // tsc over a whole project exceeds the 1 MB default when the repo has a
    // backlog of errors, and the overflow surfaces as ENOBUFS rather than as
    // anything a reader would connect to output size.
    maxBuffer: 64 * 1024 * 1024
  })
  const errors = `${run.stdout}${run.stderr}`
    .split('\n')
    .filter((line) => mine.some((file) => line.startsWith(`${file}(`)))

  if (errors.length > 0) {
    failed = true
    console.error(`\ntypecheck (${config}) — ${errors.length} error(s) in changed files:`)
    for (const line of errors) console.error(`  ${line}`)
  }
}

if (failed) {
  console.error('\nType errors in files this change touched. Fix them before committing.')
  process.exit(1)
}

console.log(`typecheck: clean across ${changed.length} changed file(s)`)
