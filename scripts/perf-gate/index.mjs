#!/usr/bin/env node
/**
 * perf-gate — decide whether a set of performance results may ship.
 *
 * Reads the JSON that `tests/perf` writes and answers one question: is there a
 * DOM-rendering regression in this build. It never measures anything itself, so
 * it stays cheap enough to run from the release scripts and from the commit
 * skill's self-check.
 *
 * ## Why the checks run in this order
 *
 * Thresholds are evaluated last and only if everything before them passed. A
 * threshold check on a measurement nobody has verified is worse than no check:
 * it produces a confident wrong answer, and a report that says "all passed" is
 * more persuasive than silence. The prior round shipped a table whose
 * best-looking row was a scenario that had hung — the collector's failure path
 * had assigned the end value from the start value, so the worst run scored
 * perfectly. Everything in classes A-C exists to make that shape impossible.
 *
 *   A  the collector ran        — a failed probe records null, never a zero
 *   B  the scenario acted       — it did the thing it claims to measure
 *   C  the run is uncontaminated— no crash, reload, hang; build identity known
 *   -> only now, thresholds
 *
 * Timing, CPU and memory are read and reported but never block. They depend on
 * how fast and how busy the machine is; there is no cross-machine standard.
 *
 * Thresholds and the reasoning behind each number live in `thresholds.mjs`.
 *
 * Usage:
 *   node scripts/perf-gate/index.mjs --results tests/perf/results/<label>
 *   node scripts/perf-gate/index.mjs --results <dir> --require-fresh-build
 *   node scripts/perf-gate/index.mjs --self-test
 *
 * Exit codes:
 *   0 — every check passed
 *   1 — a check failed; the build must not ship
 *   2 — the gate could not run (missing results, unreadable JSON)
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_SKIPS,
  CSV_SIZE_DECOUPLING,
  MIN_DURATION_MS,
  MIN_NODE_DELTA,
  MIN_SAMPLING_RATIO,
  NODE_CEILINGS,
  NON_VIRTUALIZED,
  RELEASE_GATE_SCENARIOS
} from './thresholds.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '../..')
const BUILD_SIDECAR = join(PROJECT_ROOT, 'out/main/.build-identity.json')
// electron-vite has emitted both extensions across versions; take whichever
// the current build produced. Undefined when nothing is built.
const BUILD_ARTIFACT = ['index.cjs', 'index.mjs']
  .map((name) => join(PROJECT_ROOT, 'out/main', name))
  .find((candidate) => existsSync(candidate))
const SOURCE_DIR = join(PROJECT_ROOT, 'src')
const HTML_FIXTURE = JSON.parse(readFileSync(join(PROJECT_ROOT, 'tests/perf/fixtures/manifest.json'), 'utf8')).fixtures['html-extreme-2mb.html']

const FROZEN_PASS = join(PROJECT_ROOT, 'tests/perf/results/final-frozen')
const FROZEN_FAIL = join(PROJECT_ROOT, 'tests/perf/results/report-snapshot')

const DISCIPLINE = `
  Adding an exemption is never an acceptable way to turn this green.
  Fix the criterion or fix the code. See scripts/perf-gate/thresholds.mjs.`

class GateError extends Error {}

function gatedNodes(scenario, data) {
  return NODE_CEILINGS[scenario]?.metric === 'htmlPreview.rendererNodes' ? data.htmlPreview?.rendererNodes : data.nodes
}

function assertHtmlPreview(data, fail) {
  const evidence = data.htmlPreview
  if (!evidence) return fail('A', 'no HTML frame evidence — parent counters cannot measure an isolated renderer')
  const { baseline, frame, fixture, served, document, pixels, rendererNodes, rawParent } = evidence
  if (!baseline || !frame || !rendererNodes || !rawParent || !fixture || !served || !document || !pixels) return fail('A', 'HTML frame evidence is incomplete')
  const processes = rendererNodes.processes
  if (rendererNodes.counter !== 'Performance.Nodes' || rendererNodes.scope !== 'distinct-owned-renderer-processes' || !Array.isArray(processes) || !processes.length) return fail('A', 'HTML must report renderer-wide CDP Node instance counters')
  const positive = value => Number.isSafeInteger(value) && value > 0
  const identity = process => positive(process?.pid) && Number.isFinite(process.creationTime) && process.creationTime > 0 && typeof process.targetId === 'string' && process.targetId.length > 0
  if (baseline.previewFrameCount !== 0 || !identity(baseline.parent) || !identity(frame) || !Array.isArray(baseline.rendererPids)) return fail('A', 'HTML lacks a verified empty-preview baseline and native process identity')
  const frameIdentity = value => positive(value.contentsId) && Number.isSafeInteger(value.frameTreeNodeId) && Number.isSafeInteger(value.processId) && Number.isSafeInteger(value.routingId) && (value.frameToken === null || (typeof value.frameToken === 'string' && value.frameToken.length > 0))
  if (!frameIdentity(frame) || !frameIdentity(baseline.parent)) return fail('A', 'HTML frame routing identity is incomplete')
  if (processes.some(process => !identity(process) || !positive(process.nodes)) || new Set(processes.map(process => process.pid)).size !== processes.length || new Set(processes.map(process => process.targetId)).size !== processes.length) return fail('A', 'HTML renderer identities are unknown or counted more than once')
  const parent = processes.filter(process => process.role === 'parent')
  const child = processes.filter(process => process.role === 'preview')
  if (parent.length !== 1 || parent[0].pid !== baseline.parent?.pid || parent[0].creationTime !== baseline.parent?.creationTime || parent[0].targetId !== baseline.parent?.targetId || parent[0].nodes !== rawParent.end) return fail('A', 'HTML parent counter does not match the original renderer')
  const independent = frame.pid !== baseline.parent?.pid
  if (independent === (frame.processId === baseline.parent.processId)) return fail('A', 'HTML native and Chromium process identities disagree')
  if (independent) {
    if (processes.length !== 2 || child.length !== 1 || child[0].pid !== frame.pid || child[0].creationTime !== frame.creationTime || child[0].targetId !== frame.targetId || baseline.rendererPids.includes(frame.pid)) return fail('A', 'HTML child lacks an exclusive newly-owned renderer counter')
    const session = evidence.session
    if (!session || session.frameTreeId !== frame.targetId || session.frameTreeUrl !== frame.url || session.runtimeUrl !== frame.url || typeof session.targetInfoUrl !== 'string' || session.targetInfoUrlAvailable !== (session.targetInfoUrl.length > 0) || (session.targetInfoUrlAvailable && session.targetInfoUrl !== frame.url)) return fail('A', 'HTML child session frame tree and runtime do not identify the actual native document')
  } else if (processes.length !== 1 || child.length !== 0 || frame.targetId !== baseline.parent?.targetId) return fail('A', 'An in-process HTML frame must use the parent counter exactly once')
  if (rawParent.start !== data.nodes?.start || rawParent.end !== data.nodes?.end || rawParent.delta !== data.nodes?.delta || rendererNodes.start !== rawParent.start || rendererNodes.end !== processes.reduce((sum, process) => sum + process.nodes, 0) || rendererNodes.delta !== rendererNodes.end - rendererNodes.start) fail('A', 'HTML combined counter arithmetic does not preserve the raw parent measurement')
  const owner = independent ? child[0] : parent[0]
  if (!positive(document.attachedNodes) || document.attachedNodes < document.elements || owner?.nodes < document.attachedNodes) fail('A', 'HTML renderer counter does not cover its actual attached DOM')
  if (fixture.name !== 'html-extreme-2mb.html' || fixture.bytes !== HTML_FIXTURE.bytes || fixture.sha256 !== HTML_FIXTURE.sha256 || served.status !== 200 || served.bytes !== fixture.bytes || served.sha256 !== fixture.sha256) fail('B', 'HTML served bytes/hash do not match the complete registered fixture')
  if (served.requestUrl !== frame.url || typeof served.responseUrl !== 'string' || served.responseUrlAvailable !== (served.responseUrl.length > 0) || served.redirected !== false || (served.responseUrlAvailable && served.responseUrl !== frame.url)) fail('B', 'HTML served request/response identity is inconsistent with the owned frame')
  let url
  let fileName
  try { url = new URL(frame.url); fileName = decodeURIComponent(url.pathname).slice(1) } catch { fail('B', 'HTML frame URL is invalid') }
  if (url?.protocol !== 'halo-preview:' || fileName !== fixture.name || document.url !== frame.url || frame.contentsId !== baseline.parent?.contentsId || frame.frameTreeNodeId === baseline.parent?.frameTreeNodeId) fail('B', 'HTML content is not the owned active preview frame')
  if (document.readyState !== 'complete' || document.title !== 'Perf Fixture' || document.heading !== 'Perf Fixture HTML' || !positive(fixture.elements) || document.elements !== fixture.elements || !positive(fixture.sections) || document.sections !== fixture.sections || document.lastSection !== fixture.lastSection) fail('B', 'HTML complete document structure was not verified')
  const area = pixels.width * pixels.height
  if (!(pixels.width > 100 && pixels.height > 100 && pixels.opaquePixels === area && pixels.inkPixels > 100 && pixels.inkPixels <= area && pixels.bytes > 0) || !/^[0-9a-f]{64}$/.test(pixels.sha256 ?? '') || typeof pixels.artifact !== 'string' || !pixels.artifact.endsWith('.png')) fail('B', 'HTML has no nonempty opaque compositor image containing fixture ink')
  if (!(evidence.pixelReadyMsFromOpen >= data.durationMs && evidence.evidenceVerificationMs > 0 && evidence.verificationAfterSampling === true)) fail('B', 'HTML pixel checkpoint and verification overhead were not recorded with their actual timing scope')
}

function readResult(dir, scenario) {
  const file = join(dir, `${scenario}.json`)
  if (!existsSync(file)) return null
  try {
    return { file, data: JSON.parse(readFileSync(file, 'utf-8')) }
  } catch (err) {
    throw new GateError(`${file} is not readable JSON: ${err.message}`)
  }
}

/**
 * A registered skip, or null. Returning the reason rather than a boolean keeps
 * the summary able to say what was not measured — a run where nothing executed
 * must not read the same as a run where everything passed.
 *
 * No scenario in the current gate set can skip: all nine open a local fixture
 * and need no API key or service. That is precisely why this path has to be
 * exercised by the self-test rather than by a real run — it went unreachable
 * once already, disagreeing with `writeSkipResult` on both the field name and
 * the vocabulary, and nothing noticed.
 */
function registeredSkip(scenario, data) {
  const status = data.status
  if (status !== 'skipped' && status !== 'precondition-failed') return null
  const allowed = ALLOWED_SKIPS[scenario] ?? []
  const reason = data.skipReason ?? null
  if (reason && allowed.includes(reason)) return reason
  throw new GateError(
    `${scenario} reported status='${status}' with skipReason=${JSON.stringify(reason)}, ` +
      `which is not registered in ALLOWED_SKIPS. An unregistered skip is a failure: ` +
      `it is how a run where nothing happened comes to look clean.`
  )
}

/** Class A — the collector ran. Null is the harness's contract for a failed probe. */
function assertCollected(scenario, data, fail) {
  if (NODE_CEILINGS[scenario]?.metric === 'htmlPreview.rendererNodes') assertHtmlPreview(data, fail)
  const nodes = gatedNodes(scenario, data)
  if (!nodes) return fail('A', `no 'nodes' block — the CDP metrics probe never reported`)
  if (nodes.end === null || nodes.end === undefined) fail('A', `nodes.end is null — the probe failed`)
  if (nodes.delta === null || nodes.delta === undefined) fail('A', `nodes.delta is null — the probe failed`)
  if (!(nodes.start > 0)) fail('A', `nodes.start is ${nodes.start} — CDP metrics never attached`)

  const sampling = data.sampling
  if (!sampling) return fail('A', `no 'sampling' block — cannot tell how much of the run was observed`)
  if (!(sampling.succeededTicks > 0)) return fail('A', `sampling.succeededTicks is 0 — nothing was sampled`)
  const ratio = sampling.succeededTicks / sampling.plannedTicks
  if (ratio < MIN_SAMPLING_RATIO) {
    fail('A', `only ${sampling.succeededTicks}/${sampling.plannedTicks} ticks sampled (${(ratio * 100).toFixed(0)}%)`)
  }

  if ((data.unmeasuredMetrics ?? []).includes('nodes')) {
    fail('A', `'nodes' is listed in unmeasuredMetrics — the gated metric was not measured`)
  }
}

/** Class B — the scenario performed the action it claims to measure. */
function assertActed(scenario, data, fail) {
  if (data.status !== 'ok') {
    fail('B', `status is ${JSON.stringify(data.status)}, expected 'ok'`)
  }
  const delta = gatedNodes(scenario, data)?.delta
  if (typeof delta === 'number' && delta < MIN_NODE_DELTA) {
    fail(
      'B',
      `nodes.delta is ${delta}, below the ${MIN_NODE_DELTA} floor — the viewer rendered ` +
        `nothing, so there is no measurement here to compare against a ceiling`
    )
  }
  if (!(data.durationMs > MIN_DURATION_MS)) {
    fail('B', `durationMs is ${data.durationMs} — too fast to have opened anything`)
  }
}

/** Class C — the run was not contaminated. Contamination makes results look better, not worse. */
function assertUncontaminated(scenario, data, fail) {
  if (data.valid !== true) fail('C', `valid is ${data.valid}`)
  if (data.crashCount > 0) fail('C', `${data.crashCount} renderer crash(es)`)
  if (data.rendererReloads > 0) {
    fail('C', `${data.rendererReloads} silent renderer reload(s) — a reload resets every injected observer`)
  }
  if (data.unresponsiveCount > 0) fail('C', `${data.unresponsiveCount} unresponsive event(s)`)
  if (!Array.isArray(data.loadAverage)) {
    fail('C', `no loadAverage recorded — a number cannot be read without knowing how busy the machine was`)
  }
  if (typeof data.gitSha === 'string' && data.gitSha.includes('unverified')) {
    fail('C', `gitSha is '${data.gitSha}' — the binary under test was never identified`)
  }
}

function newestMtimeUnder(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const mtime = entry.isDirectory() ? newestMtimeUnder(full) : statSync(full).mtimeMs
    if (mtime > newest) newest = mtime
  }
  return newest
}

/**
 * Class C, build-level. Measuring a stale `out/` means grading last week's code
 * and passing. `tests/perf/lib/build-identity.ts` falls back to live HEAD when
 * the sidecar is absent, which reads like a normal sha while the binary is
 * whatever was built last — so an unverified or stale build is a hard failure
 * here, never a note.
 */
function assertFreshBuild(resultDir, failures) {
  const fail = (msg) => failures.push({ scenario: '(build)', cls: 'C', message: msg })

  if (!existsSync(BUILD_SIDECAR)) {
    return fail(
      `out/main/.build-identity.json is missing — run 'npm run test:perf:record-build' ` +
        `immediately after 'npm run build'. Without it the results cannot be tied to a binary.`
    )
  }
  let sidecar
  try {
    sidecar = JSON.parse(readFileSync(BUILD_SIDECAR, 'utf-8'))
  } catch (err) {
    return fail(`out/main/.build-identity.json is unreadable: ${err.message}`)
  }

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim()
  if (sidecar.sha !== head) {
    fail(`the measured build is ${sidecar.sha} but HEAD is ${head} — these results describe different code`)
  }

  if (!BUILD_ARTIFACT) return fail(`out/main/index.{cjs,mjs} is missing — nothing was built`)
  const builtAt = statSync(BUILD_ARTIFACT).mtimeMs
  const newestSource = newestMtimeUnder(SOURCE_DIR)
  if (newestSource > builtAt) {
    fail(
      `src/ has changed since out/main/${basename(BUILD_ARTIFACT)} was built — the results measure the previous build. ` +
        `Run 'npm run build' again.`
    )
  }

  const recordedAt = Date.parse(sidecar.recordedAt)
  const stale = RELEASE_GATE_SCENARIOS.filter((scenario) => {
    const file = join(resultDir, `${scenario}.json`)
    return existsSync(file) && statSync(file).mtimeMs < recordedAt
  })
  if (stale.length > 0) {
    fail(
      `${stale.length} result file(s) predate the build (${stale.join(', ')}) — ` +
        `this is a stale results directory, not a fresh run`
    )
  }
}

export function runGate(resultDir, { requireFreshBuild = false } = {}) {
  const failures = []
  const skipped = []
  const measured = new Map()

  for (const scenario of RELEASE_GATE_SCENARIOS) {
    const fail = (cls, message) => failures.push({ scenario, cls, message })
    const found = readResult(resultDir, scenario)
    if (!found) {
      fail('A', `no result file — a scenario that did not run is a failure, not a skip`)
      continue
    }
    const { data } = found

    const skipReason = registeredSkip(scenario, data)
    if (skipReason) {
      skipped.push({ scenario, reason: skipReason })
      continue
    }

    const before = failures.length
    assertCollected(scenario, data, fail)
    assertActed(scenario, data, fail)
    assertUncontaminated(scenario, data, fail)
    if (failures.length === before) measured.set(scenario, data)
  }

  if (requireFreshBuild) assertFreshBuild(resultDir, failures)

  // Thresholds are evaluated per scenario, on the scenarios that earned it.
  // `measured` holds only those that cleared A-C, so a contaminated scenario
  // suppresses its own threshold and nothing else — blinding the other nine
  // would hide exactly the regression this gate exists to catch.
  for (const [scenario, data] of measured) {
    const { ceiling, anchor } = NODE_CEILINGS[scenario]
    const delta = gatedNodes(scenario, data).delta
    if (delta > ceiling) {
      failures.push({
        scenario,
        cls: 'threshold',
        message: `nodes.delta ${delta} exceeds the ${ceiling} ceiling (post-fix anchor was ${anchor})`
      })
    }
  }

  const csvDeltas = CSV_SIZE_DECOUPLING.scenarios.map((s) => measured.get(s)?.nodes?.delta)
  if (csvDeltas.every((d) => typeof d === 'number')) {
    const min = Math.min(...csvDeltas)
    const max = Math.max(...csvDeltas)
    if (min >= CSV_SIZE_DECOUPLING.minDelta && max > min * CSV_SIZE_DECOUPLING.maxRatio) {
      failures.push({
        scenario: CSV_SIZE_DECOUPLING.scenarios.join(' / '),
        cls: 'threshold',
        message:
          `CSV node counts ${csvDeltas.join(', ')} span ${(max / min).toFixed(1)}x across a 100x file-size range ` +
          `(limit ${CSV_SIZE_DECOUPLING.maxRatio}x). Node count is tracking file size, which means ` +
          `virtualization is no longer doing its job.`
      })
    }
  }

  return { failures, skipped, measured }
}

function report(resultDir, { failures, skipped, measured }) {
  console.log(`perf-gate: ${resultDir}`)

  for (const { scenario, reason } of skipped) {
    console.log(`  SKIP  ${scenario} — ${reason} (registered)`)
  }
  const overCeiling = new Set(failures.filter((f) => f.cls === 'threshold').map((f) => f.scenario))
  for (const [scenario, data] of measured) {
    const { ceiling } = NODE_CEILINGS[scenario]
    const load = Array.isArray(data.loadAverage) ? data.loadAverage[0].toFixed(2) : 'n/a'
    const flag = NON_VIRTUALIZED[scenario] ? '  (not virtualized — see thresholds.mjs)' : ''
    console.log(
      `  ${overCeiling.has(scenario) ? 'OVER' : 'ok  '}  ${scenario.padEnd(22)}` +
        ` nodes +${String(gatedNodes(scenario, data).delta).padStart(7)} / ${ceiling}` +
        `   ${String(data.durationMs).padStart(6)}ms  load ${load}${flag}`
    )
  }

  if (failures.length === 0) {
    console.log(`perf-gate: PASS (${measured.size} measured, ${skipped.length} registered skips)`)
    return true
  }

  console.error('')
  for (const { scenario, cls, message } of failures) {
    console.error(`  FAIL [${cls}] ${scenario}: ${message}`)
  }
  console.error(`\nperf-gate: FAIL (${failures.length} problem(s))`)
  console.error(DISCIPLINE)
  return false
}

/**
 * The gate's own negative control.
 *
 * A criterion nobody has watched fail has not been verified; it has only failed
 * to go red. So each class is fed an input that must trip it, and the two
 * frozen corpora are run end to end: the pre-fix snapshot must be rejected, the
 * post-fix one accepted. Without this, a gate that silently stopped checking
 * anything would look exactly like a gate that passes.
 */
function selfTest() {
  const problems = []

  if (!existsSync(FROZEN_PASS) || !existsSync(FROZEN_FAIL)) {
    console.error(
      `perf-gate self-test: frozen corpora missing (${FROZEN_PASS}, ${FROZEN_FAIL}).\n` +
        `They are tracked fixtures, not run residue — restore them before trusting this gate.`
    )
    return 2
  }

  // The historical HTML record predates frame evidence. A synthetic control
  // exercises the new schema without modifying or certifying that old result.
  const htmlControl = JSON.parse(readFileSync(join(FROZEN_PASS, 's5-html.json'), 'utf8'))
  htmlControl.nodes = { start: 542, end: 515, delta: -27 }
  const previewUrl = 'halo-preview://controlled/html-extreme-2mb.html'
  const parentIdentity = { pid: 101, creationTime: 1000, contentsId: 1, frameTreeNodeId: 1, processId: 1, routingId: 1, frameToken: 'parent-frame', url: 'file:///controlled/index.html', targetId: 'parent-target' }
  const childIdentity = { pid: 102, creationTime: 2000, contentsId: 1, frameTreeNodeId: 2, processId: 2, routingId: 1, frameToken: 'preview-frame', url: previewUrl, targetId: 'preview-target' }
  htmlControl.htmlPreview = {
    baseline: { previewFrameCount: 0, parent: parentIdentity, rendererPids: [101] }, frame: childIdentity,
    session: { targetInfoUrl: previewUrl, targetInfoUrlAvailable: true, frameTreeId: 'preview-target', frameTreeUrl: previewUrl, runtimeUrl: previewUrl },
    fixture: { name: 'html-extreme-2mb.html', ...HTML_FIXTURE, elements: 125955, sections: 2548, lastSection: 'Section 2548' },
    served: { ...HTML_FIXTURE, status: 200, requestUrl: previewUrl, responseUrl: previewUrl, responseUrlAvailable: true, redirected: false },
    document: { url: previewUrl, title: 'Perf Fixture', readyState: 'complete', elements: 125955, attachedNodes: 262900, sections: 2548, lastSection: 'Section 2548', heading: 'Perf Fixture HTML' },
    pixels: { width: 400, height: 320, opaquePixels: 128000, inkPixels: 1000, bytes: 1000, sha256: 'a'.repeat(64), artifact: 'synthetic-preview.png' },
    pixelReadyMsFromOpen: 5000, evidenceVerificationMs: 100, verificationAfterSampling: true,
    rawParent: { ...htmlControl.nodes },
    rendererNodes: { counter: 'Performance.Nodes', scope: 'distinct-owned-renderer-processes', start: 542, end: 263495, delta: 262953, processes: [
      { role: 'parent', pid: 101, creationTime: 1000, targetId: 'parent-target', nodes: 515 },
      { role: 'preview', pid: 102, creationTime: 2000, targetId: 'preview-target', nodes: 262980 },
    ] },
  }
  const controlled = mkdtempSync(join(tmpdir(), 'halo-perf-gate-control-'))
  let post
  try {
    cpSync(FROZEN_PASS, controlled, { recursive: true })
    writeFileSync(join(controlled, 's5-html.json'), JSON.stringify(htmlControl))
    post = runGate(controlled)
  } finally { rmSync(controlled, { recursive: true, force: true }) }
  if (post.failures.length > 0) {
    problems.push(`post-fix corpus should pass but reported: ${post.failures.map((f) => `${f.scenario}: ${f.message}`).join('; ')}`)
  }

  // Asserting only "the pre-fix corpus fails" is not enough, and this is not
  // hypothetical: an earlier version of this gate suppressed every threshold as
  // soon as any scenario was contaminated, so the pre-fix corpus failed solely
  // on its one crashed scenario while four de-virtualized viewers were reported
  // as ok. The corpus-level check stayed green throughout. Name the scenarios
  // the ceilings must catch.
  const pre = runGate(FROZEN_FAIL)
  const caught = new Set(pre.failures.filter((f) => f.cls === 'threshold').map((f) => f.scenario))
  for (const scenario of ['s4-markdown-preview', 's5-markdown', 's5-csv-50kb', 's5-csv-500kb']) {
    if (!caught.has(scenario)) {
      problems.push(`pre-fix ${scenario} rendered the whole file and no ceiling caught it`)
    }
  }

  const baseline = JSON.parse(readFileSync(join(FROZEN_PASS, 's5-csv-500kb.json'), 'utf-8'))
  const mutants = [
    ['A', 'null node delta', (d) => { d.nodes.delta = null }],
    ['A', 'probe never attached', (d) => { d.nodes.start = 0 }],
    ['A', 'half the ticks lost', (d) => { d.sampling.succeededTicks = 1 }],
    ['B', 'rendered nothing', (d) => { d.nodes.delta = 0 }],
    ['B', 'scenario hung', (d) => { d.status = 'hung' }],
    ['C', 'renderer crashed', (d) => { d.crashCount = 1 }],
    ['C', 'silent reload', (d) => { d.rendererReloads = 1 }],
    ['C', 'marked invalid', (d) => { d.valid = false }],
    ['C', 'unidentified binary', (d) => { d.gitSha = 'abc123 (unverified: run tests/perf/record-build.mjs after building)' }],
    ['threshold', 'de-virtualized', (d) => { d.nodes.delta = 144889 }]
  ]

  for (const [cls, label, mutate] of mutants) {
    const data = JSON.parse(JSON.stringify(baseline))
    mutate(data)
    const failures = []
    const fail = (c, message) => failures.push({ c, message })
    assertCollected('mutant', data, fail)
    if (failures.length === 0) assertActed('mutant', data, fail)
    if (failures.length === 0) assertUncontaminated('mutant', data, fail)
    if (failures.length === 0 && data.nodes.delta > NODE_CEILINGS['s5-csv-500kb'].ceiling) failures.push({ c: 'threshold' })
    if (failures.length === 0) problems.push(`class ${cls} does not catch "${label}" — that criterion is decorative`)
  }

  const htmlMutants = [
    ['missing frame evidence', data => { delete data.htmlPreview }],
    ['double-counted renderer', data => { data.htmlPreview.rendererNodes.processes.push({ ...data.htmlPreview.rendererNodes.processes[1] }) }],
    ['unknown process identity', data => { data.htmlPreview.frame.pid = null }],
    ['unmeasured prior child counter', data => { data.htmlPreview.baseline.rendererPids.push(102) }],
    ['wrong served bytes', data => { data.htmlPreview.served.bytes = 10 }],
    ['wrong served request', data => { data.htmlPreview.served.requestUrl = 'halo-preview://foreign/other.html' }],
    ['wrong nonempty response URL', data => { data.htmlPreview.served.responseUrl = 'halo-preview://foreign/other.html' }],
    ['incomplete document', data => { data.htmlPreview.document.elements = 10 }],
    ['empty compositor image', data => { data.htmlPreview.pixels.inkPixels = 0 }],
    ['counter omits child', data => { data.htmlPreview.rendererNodes.end = 515 }],
    ['missing child session identity', data => { data.htmlPreview.session = null }],
    ['session bound to parent target', data => { data.htmlPreview.session.frameTreeId = 'parent-target' }],
    ['session executes the wrong document', data => { data.htmlPreview.session.runtimeUrl = 'file:///controlled/index.html' }],
  ]
  for (const [label, mutate] of htmlMutants) {
    const data = structuredClone(htmlControl)
    mutate(data)
    const failures = []
    const fail = (cls, message) => failures.push({ cls, message })
    assertCollected('s5-html', data, fail)
    assertActed('s5-html', data, fail)
    if (!failures.length) problems.push(`HTML gate accepted ${label}`)
  }
  const inProcess = structuredClone(htmlControl)
  const shared = inProcess.htmlPreview
  shared.frame = { ...shared.frame, pid: 101, processId: 1, creationTime: 1000, targetId: 'parent-target' }
  shared.session = null
  shared.rawParent = inProcess.nodes = { start: 542, end: 263495, delta: 262953 }
  shared.rendererNodes.processes = [{ role: 'parent', pid: 101, creationTime: 1000, targetId: 'parent-target', nodes: 263495 }]
  const inProcessFailures = []
  assertCollected('s5-html', inProcess, (_cls, message) => inProcessFailures.push(message))
  assertActed('s5-html', inProcess, (_cls, message) => inProcessFailures.push(message))
  if (inProcessFailures.length) problems.push(`HTML same-process control failed: ${inProcessFailures.join('; ')}`)
  const unavailableTargetUrl = structuredClone(htmlControl)
  unavailableTargetUrl.htmlPreview.session.targetInfoUrl = ''
  unavailableTargetUrl.htmlPreview.session.targetInfoUrlAvailable = false
  const unavailableFailures = []
  assertCollected('s5-html', unavailableTargetUrl, (_cls, message) => unavailableFailures.push(message))
  assertActed('s5-html', unavailableTargetUrl, (_cls, message) => unavailableFailures.push(message))
  if (unavailableFailures.length) problems.push(`HTML verified child session with an unavailable target-info URL failed: ${unavailableFailures.join('; ')}`)
  const syntheticResponse = structuredClone(htmlControl)
  syntheticResponse.htmlPreview.served.responseUrl = ''
  syntheticResponse.htmlPreview.served.responseUrlAvailable = false
  const syntheticResponseFailures = []
  assertCollected('s5-html', syntheticResponse, (_cls, message) => syntheticResponseFailures.push(message))
  assertActed('s5-html', syntheticResponse, (_cls, message) => syntheticResponseFailures.push(message))
  if (syntheticResponseFailures.length) problems.push(`HTML verified synthetic response with an unavailable response URL failed: ${syntheticResponseFailures.join('; ')}`)

  // The skip contract, checked against what `writeSkipResult` actually writes
  // rather than against what this file assumes it writes.
  const [skipScenario, skipReasons] = Object.entries(ALLOWED_SKIPS)[0]
  const registered = { ...baseline, status: 'skipped', skipReason: skipReasons[0] }
  if (registeredSkip(skipScenario, registered) !== skipReasons[0]) {
    problems.push(`a registered skip for ${skipScenario} was not recognised — ALLOWED_SKIPS is unreachable`)
  }
  for (const [label, data] of [
    ['an unregistered reason', { ...baseline, status: 'skipped', skipReason: 'ran-out-of-time' }],
    ['no reason at all', { ...baseline, status: 'skipped' }]
  ]) {
    try {
      registeredSkip(skipScenario, data)
      problems.push(`${label} was accepted as a skip — a run where nothing happened would read as clean`)
    } catch (err) {
      if (!(err instanceof GateError)) throw err
    }
  }

  if (problems.length > 0) {
    console.error('perf-gate self-test: FAIL')
    for (const p of problems) console.error(`  ${p}`)
    return 1
  }
  console.log(
    `perf-gate self-test: PASS (frozen corpora, explicit synthetic HTML controls, ${mutants.length + htmlMutants.length} criterion mutants and the skip contract)`
  )
  return 0
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest()

  const at = argv.indexOf('--results')
  if (at === -1 || !argv[at + 1]) {
    console.error('usage: perf-gate --results <dir> [--require-fresh-build] | --self-test')
    return 2
  }
  const resultDir = resolve(PROJECT_ROOT, argv[at + 1])
  if (!existsSync(resultDir)) {
    console.error(`perf-gate: ${resultDir} does not exist — the measurement run did not produce results`)
    return 2
  }

  const outcome = runGate(resultDir, { requireFreshBuild: argv.includes('--require-fresh-build') })
  return report(resultDir, outcome) ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (err) {
    console.error(`perf-gate: ${err instanceof GateError ? err.message : err.stack}`)
    process.exit(err instanceof GateError ? 1 : 2)
  }
}
