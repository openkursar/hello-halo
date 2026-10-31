import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { assertBaselineRun, comparableBaseline, git, makeBaseline, readJson, renderSummary } from './ci-state.mjs'
import { compareResults } from './lib/quality.mjs'
import { stoppedEvidenceProducers, freezeEvidence, verifyEvidenceSource, writeEvidenceJson, writeEvidenceText, assertOwnedEvidencePath } from './lib/ci-evidence.mjs'

const within = (parent, file) => { const relative = path.relative(parent, file); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function appendJobSummary(directory, file, summary) {
  if (!file) return
  const target = path.resolve(file)
  const canonical = path.join(fs.realpathSync(path.dirname(target)), path.basename(target))
  if (within(directory, target) || within(directory, canonical)) throw new Error('The job summary must be separate from the evidence payload')
  const fd = fs.openSync(canonical, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('The job summary must be a regular file')
    fs.writeFileSync(fd, summary)
  } finally { fs.closeSync(fd) }
}

function collectDiagnostics(root, directory, producers) {
  const copied = [], unavailable = []
  for (const producer of producers) {
    for (const relative of producer.evidencePaths ?? []) {
      if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('A producer diagnostic path is invalid')
      const file = path.resolve(root, relative)
      if (!within(path.join(root, 'tests/acceptance/output'), file)) throw new Error('A producer diagnostic leaves the output area')
      assertOwnedEvidencePath(root, file)
      if (within(directory, file)) continue
      let before
      try { before = fs.lstatSync(file) }
      catch (error) { if (error.code === 'ENOENT') { unavailable.push({ path: relative, reason: 'not-created' }); continue } throw error }
      if (!before.isFile() || before.isSymbolicLink() || !within(root, fs.realpathSync(file)) || before.size > 32 * 1024 * 1024) throw new Error('A producer diagnostic is not a bounded owned regular file')
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      let bytes
      try {
        const opened = fs.fstatSync(fd)
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('A producer diagnostic changed identity')
        bytes = fs.readFileSync(fd)
        const after = fs.fstatSync(fd)
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('A producer diagnostic changed after producer completion')
      } finally { fs.closeSync(fd) }
      const folder = path.join(directory, 'diagnostics', producer.id)
      assertOwnedEvidencePath(root, folder)
      fs.mkdirSync(folder, { recursive: true })
      if (fs.realpathSync(folder) !== folder) throw new Error('Diagnostic collection directory is not owned')
      const destination = path.join(folder, path.basename(file))
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 | (before.mode & 0o040) })
      copied.push({ source: relative, path: path.relative(directory, destination).split(path.sep).join('/'), bytes: bytes.length, sha256: hash(bytes) })
    }
  }
  writeEvidenceJson(path.join(directory, 'diagnostic-collection.json'), { version: 1, copied, unavailable }, { exclusive: true, mode: 0o640 })
  return unavailable
}

/** The earlier results a run can be compared with, or null when there are none or they cannot be trusted. */
function earlierResults(context, file, defaultRef) {
  if (!file || !fs.existsSync(file)) return null
  try { return comparableBaseline(readJson(file), context, defaultRef) }
  catch (error) {
    console.warn(`[Acceptance CI] The earlier results could not be read (${error.message}); this run is reported without a comparison.`)
    return null
  }
}

export function finalizeCi(root, { identity, stageOutcomes = {}, summaryFile, baselineFile, defaultRef } = {}) {
  root = fs.realpathSync(root)
  const directory = path.join(root, 'tests/acceptance/output/ci')
  assertOwnedEvidencePath(root, directory)
  if (fs.existsSync(path.join(directory, 'evidence-freeze.json'))) throw new Error('Frozen CI evidence cannot be finalized again')
  let context
  try {
    context = readJson(path.join(directory, 'context.json'))
    if (!context || typeof context !== 'object' || Array.isArray(context) || !/^[a-f0-9]{40}$/.test(context.revision ?? '')) throw new Error('Captured CI context has no fixed source identity')
  } catch (error) {
    const unavailable = { repository: process.env.HALO_SOURCE_REPOSITORY, ref: process.env.HALO_SOURCE_REF, profile: process.env.HALO_ACCEPTANCE_PROFILE, platform: process.platform, architecture: process.arch }
    const summary = renderSummary(unavailable, null, stageOutcomes) + '\nSource context: **unavailable or unreadable**. Acceptance execution is not established by complete evidence. No cases are claimed as passing; no freeze or baseline is eligible. The evidence payload was not changed.\n'
    appendJobSummary(directory, summaryFile, summary)
    throw Object.assign(new Error('Captured CI context is unavailable or unreadable; evidence cannot be finalized', { cause: error }), { code: 'EVIDENCE_CONTEXT_UNAVAILABLE' })
  }
  let state
  try {
    state = stoppedEvidenceProducers(root, { identity })
    if (git(['rev-parse', 'HEAD'], root) !== context.revision) throw new Error('The source checkout changed before evidence finalization')
  } catch (error) {
    const summary = renderSummary(context, null, stageOutcomes) + '\nEvidence finality: **unconfirmed**. The owner or another registered evidence producer has not established completion. No run results are claimed while writers are unconfirmed; no freeze or baseline is eligible.\n'
    appendJobSummary(directory, summaryFile, summary)
    throw error
  }
  const runFile = path.join(directory, 'run/run.json')
  let run = null
  try {
    if (fs.existsSync(runFile)) {
      assertOwnedEvidencePath(root, runFile)
      run = readJson(runFile)
      if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('The run record must be a JSON object')
    }
  } catch (error) {
    const summary = renderSummary(context, null, stageOutcomes) + '\nRun evidence: **unreadable** after producer completion. No cases are claimed as passing; no freeze or baseline is eligible. The evidence payload was not changed.\n'
    appendJobSummary(directory, summaryFile, summary)
    throw Object.assign(new Error('The completed run record is unreadable; evidence cannot be finalized', { cause: error }), { code: 'EVIDENCE_RUN_UNREADABLE' })
  }
  const unavailable = collectDiagnostics(root, directory, state.producers)
  const previous = earlierResults(context, baselineFile, defaultRef)
  let quality = null
  try { quality = run ? compareResults(run, previous) : null }
  catch (error) { console.warn(`[Acceptance CI] The quality findings could not be derived from the run record (${error.message}); the summary reports the raw counts only.`) }
  if (quality) writeEvidenceJson(path.join(directory, 'quality.json'), quality, { exclusive: true, mode: 0o640 })
  let baselineFailure
  const scoped = Boolean(context.modules?.length || context.cases?.length)
  const mayAdvance = state.owner.outcome === 'passed' && (!stageOutcomes.execute || stageOutcomes.execute.outcome === 'success') && !scoped && run?.completion?.executed > 0
  if (mayAdvance) {
    try {
      assertBaselineRun(context, run)
      if (unavailable.length) throw new Error('Registered diagnostics are missing from a nominally passing run')
    } catch (error) { baselineFailure = error }
  }
  const summary = renderSummary(context, run, stageOutcomes, quality) + `\nEvidence producers: **stopped**. CI owner outcome: **${state.owner.outcome}**.\n` + (baselineFailure ? `\nBaseline withheld: ${baselineFailure.message}\n` : '')
  writeEvidenceText(path.join(directory, 'summary.md'), summary, { mode: 0o640 })
  appendJobSummary(directory, summaryFile, summary)
  const frozen = freezeEvidence(root, { identity: state.scope.identity })
  verifyEvidenceSource(root, { identity: state.scope.identity })
  if (baselineFailure) throw baselineFailure
  let baselineOutput = null
  if (mayAdvance) {
    const baselineDirectory = path.join(root, 'tests/acceptance/output/ci-baseline')
    fs.mkdirSync(baselineDirectory, { recursive: true })
    if (fs.realpathSync(baselineDirectory) !== baselineDirectory) throw new Error('Baseline output directory is not owned')
    baselineOutput = path.join(baselineDirectory, 'baseline.json')
    writeEvidenceJson(baselineOutput, makeBaseline(context, run, frozen, previous), { exclusive: true, mode: 0o640 })
  }
  return { final: true, outcome: state.owner.outcome, freezeSha256: frozen.freezeSha256, baselineFile: baselineOutput, quality }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const identity = process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT || '1' } : undefined
    const result = finalizeCi(process.cwd(), { identity, stageOutcomes: process.env.HALO_CI_STAGE_OUTCOMES ? JSON.parse(process.env.HALO_CI_STAGE_OUTCOMES) : {}, summaryFile: process.env.GITHUB_STEP_SUMMARY, baselineFile: process.env.HALO_ACCEPTANCE_BASELINE, defaultRef: process.env.HALO_DEFAULT_SOURCE_REF })
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `final=true\nfreeze-sha256=${result.freezeSha256}\nbaseline-file=${result.baselineFile ?? ''}\nnew-failures=${result.quality?.newFailures.length ?? ''}\nfailing=${result.quality ? result.quality.counts.failed : ''}\n`)
    console.log(`[Acceptance CI] Evidence frozen; owner outcome ${result.outcome}. Baseline ${result.baselineFile ? 'eligible' : 'withheld'}.`)
  } catch (error) {
    console.error(`[Acceptance CI] Evidence finalization failed: ${error.message}`)
    process.exitCode = 1
  }
}
