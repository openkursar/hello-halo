import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertOwnedEvidencePath, writeEvidenceJson, writeEvidenceText } from './lib/ci-evidence.mjs'
import { nextResults, renderQuality } from './lib/quality.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const shaPattern = /^[a-f0-9]{40}$/

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function sdkIdentity(root) {
  const sdk = path.join(root, 'src/sdk/halo-sdk')
  if (!fs.existsSync(path.join(sdk, 'package.json'))) return { state: 'absent' }
  const real = fs.realpathSync(sdk)
  let revision = null
  let changedFiles = null
  try {
    if (fs.realpathSync(git(['rev-parse', '--show-toplevel'], real)) === real) {
      revision = git(['rev-parse', 'HEAD'], real)
      const status = git(['status', '--porcelain', '--untracked-files=normal'], real)
      changedFiles = status ? status.split('\n').length : 0
    }
  } catch {
    console.warn('[Acceptance CI] SDK source revision is unavailable; its build is not a reproducible baseline.')
  }
  const digest = createHash('sha256')
  let files = 0
  const dist = path.join(real, 'dist')
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) {
        digest.update(path.relative(dist, file).split(path.sep).join('/') + '\0')
        digest.update(fs.readFileSync(file))
        files++
      }
    }
  }
  if (fs.existsSync(dist)) walk(dist)
  return { state: 'present', revision, dirty: changedFiles === null ? null : changedFiles > 0, changedFiles, buildHash: files ? digest.digest('hex') : null }
}

export function parseSelection(value = '') {
  const result = [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))].sort()
  if (result.some(item => !/^[a-z][a-z0-9.-]*$/.test(item))) throw new Error('Module and case selection must use comma-separated catalog identifiers.')
  return result
}

export function contextFor({ root = process.cwd(), repository, ref = 'main', profile = 'regression', modules = [], cases = [] }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Source repository must be owner/repository.')
  if (!ref || /[\r\n\0]/.test(ref)) throw new Error('Source ref is required and must be one line.')
  if (!['fast', 'regression'].includes(profile)) throw new Error('CI profile must be fast or regression; live/external require a separate authorized run.')
  const revision = git(['rev-parse', 'HEAD'], root)
  if (!shaPattern.test(revision)) throw new Error('Source checkout did not resolve to a full commit SHA.')
  const status = git(['status', '--porcelain', '--untracked-files=normal'], root)
  return { version: 1, repository, ref, revision, dirty: Boolean(status), changedFiles: status ? status.split('\n').length : 0, profile, modules, cases, platform: process.platform, architecture: process.arch, sdk: sdkIdentity(root) }
}

export function baselineName(context) {
  const scope = [context.repository, context.ref, context.profile, context.platform, context.architecture]
  return `acceptance-baseline-v3-${hash(JSON.stringify(scope)).slice(0, 24)}`
}

/** Lineages worth reading for this run: its own branch first, then the default branch. */
export function baselineLineages(context, defaultRef) {
  const names = [baselineName(context)]
  if (defaultRef && defaultRef !== context.ref) names.push(baselineName({ ...context, ref: defaultRef }))
  return names
}

export function baselineReason(baseline, context, isAncestor) {
  if (!baseline || baseline.version !== 3 || !/^[a-f0-9]{64}$/.test(baseline.evidenceFreezeSha256 ?? '')) return 'No supported frozen baseline is available.'
  for (const key of ['repository', 'ref', 'profile', 'platform', 'architecture']) {
    if (baseline[key] !== context[key]) return key === 'ref' ? 'This branch has no baseline of its own yet; the full profile runs.' : `Baseline ${key} does not match this run.`
  }
  if (JSON.stringify(baseline.sdk) !== JSON.stringify(context.sdk)) return 'SDK identity changed.'
  if (JSON.stringify(baseline.modules ?? []) !== JSON.stringify(context.modules ?? []) || JSON.stringify(baseline.cases ?? []) !== JSON.stringify(context.cases ?? [])) return 'Baseline module or case scope changed.'
  if (!shaPattern.test(baseline.revision ?? '') || !baseline.catalogHash || !baseline.manifestHash || !baseline.runId || !baseline.completedAt) return 'Baseline identity is incomplete.'
  if (baseline.dirty !== false || baseline.sourceIdentity?.commit !== baseline.revision || baseline.sourceIdentity.dirty !== false || !baseline.sourceIdentity.worktreeHash) return 'Baseline does not describe a verified clean source checkout.'
  if (!isAncestor(baseline.revision, context.revision)) return 'Baseline is absent from this checkout or is not an ancestor of the target.'
  return null
}

/**
 * Results of a scenario that the run could not verify (no test, a missing
 * environment, a person to run it) do not hold the baseline back; only a run
 * that lost results or never executed anything cannot stand as a reference.
 */
export function assertBaselineRun(context, run) {
  if (!run) throw new Error('A complete run record is required before the baseline advances.')
  if (context.dirty !== false) throw new Error('Source checkout must be clean before the baseline advances.')
  if (context.modules?.length || context.cases?.length) throw new Error('A module or case selection cannot advance the baseline.')
  if (run.version !== 1 || !Number.isInteger(run.selectedCount) || run.selectedCount < 1) throw new Error('Only a nonempty run can advance the baseline.')
  if (run.evidenceIntegrity?.version !== 1 || run.evidenceIntegrity?.valid !== true || !Array.isArray(run.evidenceIntegrity.reasons) || run.evidenceIntegrity.reasons.length) throw new Error('Verified evidence integrity is required before the baseline advances.')
  if (run.completion?.complete !== true || !(run.completion.executed > 0)) throw new Error('Only a complete run that executed at least one scenario can advance the baseline.')
  if (!Array.isArray(run.cases) || run.cases.length !== run.selectedCount || run.cases.some(item => item.status === 'not-run')) throw new Error('Every selected case instance must reach a recorded result before the baseline advances.')
  if (run.revision?.commit !== context.revision || run.revision.dirty !== false || !run.revision.worktreeHash) throw new Error('Run revision must describe the same clean fixed source checkout.')
  for (const key of ['profile', 'platform']) {
    if (run[key] !== context[key]) throw new Error(`Run ${key} does not match the fixed CI context.`)
  }
  if (!run.id || !run.finishedAt || !run.catalogHash || !run.manifestHash) throw new Error('Run evidence is incomplete.')
  if (JSON.stringify(run.selection?.modules ?? []) !== JSON.stringify(context.modules ?? []) || JSON.stringify(run.selection?.cases ?? []) !== JSON.stringify(context.cases ?? [])) throw new Error('Run module or case scope differs from its CI context.')
  if (context.sdk.state === 'present' && (!context.sdk.revision || context.sdk.dirty !== false || !context.sdk.buildHash)) throw new Error('SDK source must have a clean known revision and a built distribution before the baseline advances.')
}

export function makeBaseline(context, run, frozen, previous = null) {
  assertBaselineRun(context, run)
  if (!frozen || !/^[a-f0-9]{64}$/.test(frozen.freezeSha256 ?? '') || frozen.receipt?.revision !== context.revision || frozen.receipt?.completion?.outcome !== 'passed' || !frozen.receipt?.payload?.files?.some(file => file.path === 'run/run.json')) throw new Error('Final frozen evidence is required before the baseline advances.')
  if (JSON.stringify(frozen.documents?.context) !== JSON.stringify(context) || JSON.stringify(frozen.documents?.run) !== JSON.stringify(run)) throw new Error('Baseline inputs must be the exact frozen context and run documents.')
  return { ...context, version: 3, evidenceFreezeSha256: frozen.freezeSha256, sourceIdentity: run.revision, catalogHash: run.catalogHash, manifestHash: run.manifestHash, runId: run.id, completedAt: run.finishedAt, results: nextResults(previous?.results, run) }
}

/**
 * Earlier results this run may be compared with: the same repository, profile
 * and platform, from this branch or the default one. The SDK and the catalog may
 * differ; selecting changes from the baseline is stricter than comparing results.
 */
export function comparableBaseline(baseline, context, defaultRef) {
  if (!baseline || baseline.version !== 3 || !baseline.runId || !baseline.results || typeof baseline.results !== 'object' || Array.isArray(baseline.results) || !Object.keys(baseline.results).length) return null
  for (const key of ['repository', 'profile', 'platform', 'architecture']) if (baseline[key] !== context[key]) return null
  if (baseline.ref !== context.ref && baseline.ref !== defaultRef) return null
  return baseline
}

export async function findBaselineRun({ repository, artifactName, workflowPath, token, apiUrl = 'https://api.github.com', request = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Controller repository must be owner/repository.')
  const get = async endpoint => {
    const response = await request(`${apiUrl}/repos/${repository}/${endpoint}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error(`Baseline lookup failed with GitHub HTTP ${response.status}.`)
    return response.json()
  }
  const data = await get(`actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`)
  const artifacts = (data.artifacts ?? []).filter(item => item.name === artifactName && !item.expired && item.workflow_run?.id)
    .sort((a, b) => b.id - a.id)
  for (const artifact of artifacts.slice(0, 20)) {
    const run = await get(`actions/runs/${artifact.workflow_run.id}`)
    if (run.status === 'completed' && run.conclusion === 'success' && run.path === workflowPath) return String(run.id)
  }
  return null
}

export async function findBaselineLineage({ names, ...lookup }) {
  for (const artifactName of names) {
    const runId = await findBaselineRun({ ...lookup, artifactName })
    if (runId) return { runId, artifactName }
  }
  return null
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

export function renderSummary(context, run, stages = {}, quality = null) {
  const escape = value => String(value ?? 'unavailable').replace(/[\r\n|`<>]/g, ' ')
  const lines = ['## Halo acceptance', '', `Source: ${escape(context.repository)} · ${escape(context.ref)} · \`${escape(context.revision)}\``, '',
    `Profile: **${escape(context.profile)}** · Platform: ${escape(context.platform)} / ${escape(context.architecture)}`]
  if (context.sdk?.revision) lines.push('', `Halo SDK: \`${escape(context.sdk.revision)}\``)
  lines.push('')
  if (context.dirty) lines.push('Source has local changes; it cannot advance the nightly baseline.', '')
  if (run) {
    const complete = run.completion?.complete === true
    if (quality) {
      if (!complete) lines.push('This run is incomplete; the findings below are partial.', '')
      lines.push(...renderQuality(quality), '')
    }
    lines.push(`Run: **${complete ? 'complete' : 'incomplete'}** · Selected instances: ${escape(run.selectedCount)}${complete ? '' : ` · ${escape((run.completion?.reasons ?? ['no completion record']).join('; '))}`}`, '', '| Status | Instances |', '| --- | ---: |')
    for (const [status, count] of Object.entries(run.summary ?? {})) lines.push(`| ${escape(status)} | ${escape(count)} |`)
  } else lines.push('Result: **blocked before a complete run record was produced**. No cases are claimed as passing.')
  if (Object.keys(stages).length) {
    lines.push('', '| CI stage | Outcome |', '| --- | --- |')
    for (const [stage, result] of Object.entries(stages)) lines.push(`| ${escape(stage)} | ${escape(result?.outcome ?? result)} |`)
  }
  lines.push('', 'This result covers the selected catalog instances. Planned, manual and unsupported cases remain visible in the handbook; they are not implied to pass.', '')
  return lines.join('\n')
}

async function main() {
  const [command] = process.argv.slice(2)
  const directory = path.resolve('tests/acceptance/output/ci')
  const contextFile = path.join(directory, 'context.json')
  const assertUnowned = () => {
    assertOwnedEvidencePath(process.cwd(), directory)
    if (fs.existsSync(path.join(directory, 'evidence-freeze.json'))) throw new Error('Frozen CI evidence cannot be rewritten by a later metadata command.')
    if (fs.existsSync(path.join(directory, 'evidence-owner.json'))) throw new Error('Recorded CI evidence can only be completed by its finalizer; metadata writes are closed.')
  }
  if (command === 'context') {
    assertUnowned()
    const context = contextFor({ repository: process.env.HALO_SOURCE_REPOSITORY, ref: process.env.HALO_SOURCE_REF || 'main', profile: process.env.HALO_ACCEPTANCE_PROFILE || 'regression', modules: parseSelection(process.env.HALO_ACCEPTANCE_MODULES), cases: parseSelection(process.env.HALO_ACCEPTANCE_CASES) })
    fs.mkdirSync(directory, { recursive: true })
    writeEvidenceJson(contextFile, context, { mode: 0o640 })
    output('artifact-name', baselineName(context))
    output('revision', context.revision)
    console.log(`[Acceptance CI] Fixed source revision ${context.revision}; SDK ${context.sdk.state}.`)
  } else if (command === 'find-baseline') {
    const context = readJson(contextFile)
    const repository = process.env.GITHUB_REPOSITORY
    const workflowPath = process.env.GITHUB_WORKFLOW_REF?.slice(repository.length + 1).split('@')[0]
    if (!workflowPath || !process.env.GH_TOKEN) throw new Error('Baseline lookup requires the controller workflow identity and an Actions read token.')
    try {
      const found = await findBaselineLineage({ names: baselineLineages(context, process.env.HALO_DEFAULT_SOURCE_REF), repository, workflowPath, token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL })
      if (found) { output('run-id', found.runId); output('artifact-name', found.artifactName) }
      console.log(found ? `[Acceptance CI] Found retained baseline run ${found.runId}.` : '[Acceptance CI] No retained baseline; selecting full regression.')
    } catch (error) {
      console.warn(`[Acceptance CI] ${error.message} Falling back to full selection.`)
    }
  } else if (command === 'summary') {
    assertUnowned()
    const context = fs.existsSync(contextFile) ? readJson(contextFile) : { repository: process.env.HALO_SOURCE_REPOSITORY, ref: process.env.HALO_SOURCE_REF, profile: process.env.HALO_ACCEPTANCE_PROFILE }
    const runFile = path.join(directory, 'run/run.json')
    const run = fs.existsSync(runFile) ? readJson(runFile) : null
    const stages = process.env.HALO_CI_STAGE_OUTCOMES ? JSON.parse(process.env.HALO_CI_STAGE_OUTCOMES) : {}
    const summary = renderSummary(context, run, stages)
    fs.mkdirSync(directory, { recursive: true })
    writeEvidenceText(path.join(directory, 'summary.md'), summary, { mode: 0o640 })
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
    else console.log(summary)
  } else throw new Error('Usage: node scripts/acceptance/ci-state.mjs context|find-baseline|summary')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[Acceptance CI] ${error.message}`); process.exitCode = 1 })
}
