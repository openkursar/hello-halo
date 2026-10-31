import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execute as executeProcess } from './lib/process.mjs'
import { createEvidenceScope, cancelEvidenceScope, finishEvidenceScope, evidenceScopeVariable, writeEvidenceJson } from './lib/ci-evidence.mjs'
import { baselineReason, git, readJson } from './ci-state.mjs'
import { failingCaseIds } from './lib/quality.mjs'
import { browserEnvironment } from './ci-prepare.mjs'

const root = fs.realpathSync(process.cwd())
const directory = path.join(root, 'tests/acceptance/output/ci')
const cli = path.join(root, 'scripts/acceptance/cli.mjs')
const stages = []
const environment = browserEnvironment(process.env)
for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) environment[name] = undefined
environment.HALO_E2E_PACKAGED_APP = undefined

let interruption = null
let scope
function interrupt(signal) {
  if (interruption) return
  interruption = { signal, receivedAt: new Date().toISOString() }
  console.error(`[Acceptance CI] Received ${signal}; stopping owned stage processes and refusing new stages.`)
  try { if (scope) cancelEvidenceScope(scope, signal) }
  catch (error) { console.error(`[Acceptance CI] Cancellation state could not be recorded: ${error.message}`) }
}
const onInterrupt = () => interrupt('SIGINT')
const onTerminate = () => interrupt('SIGTERM')

async function execute(stage, args, { env = environment, verify, program = cli, accept = [0] } = {}) {
  if (interruption) throw new Error('CI execution was cancelled; no additional stage was started.')
  console.log(`[Acceptance CI] Starting ${stage}.`)
  const record = { stage, startedAt: new Date().toISOString(), finishedAt: null, status: 'running', exitCode: null, signal: null }
  stages.push(record)
  writeEvidenceJson(path.join(directory, 'stages.json'), stages, { mode: 0o640 })
  let result, value, failure
  try {
    result = await executeProcess(root, [program, ...args], { environment: env, stdio: 'inherit', producerRole: 'ci-stage', timeoutMs: 1800000 })
    if (!interruption && accept.includes(result.code) && !result.timedOut && !result.cleanupFailed && verify) value = verify()
  } catch (error) { failure = error.message }
  record.finishedAt = new Date().toISOString()
  record.processExitCode = result && Object.hasOwn(result, 'processExitCode') ? result.processExitCode : result?.code ?? null
  record.exitCode = failure ? 1 : result?.code ?? null
  record.signal = result?.signal ?? null
  record.cleanupConfirmed = result ? !result.cleanupFailed : false
  record.status = interruption ? 'cancelled' : failure || !accept.includes(result?.code) || result?.timedOut || result?.cleanupFailed ? 'failed' : 'completed'
  if (interruption) record.interruption = interruption
  if (failure) record.error = failure
  writeEvidenceJson(path.join(directory, 'stages.json'), stages, { mode: 0o640 })
  if (record.status !== 'completed') throw new Error(`${stage} did not pass (${failure ?? record.signal ?? record.exitCode ?? record.status}).`)
  return value
}

const variantKey = variant => JSON.stringify(Object.entries(variant ?? {}).sort(([left], [right]) => left.localeCompare(right)))
const inside = (parent, file) => { const relative = path.relative(parent, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

// A scenario that fails is a finding about the product; a run that lost results is a fault of the pipeline.
function completedRun(file) {
  const run = readJson(file)
  if (run.completion?.complete !== true) throw new Error(`The run did not complete: ${(run.completion?.reasons ?? ['no completion record']).join('; ')}.`)
  return run
}

function needsRequirement(plan, requirement) {
  if (!Array.isArray(plan.cases) || !Array.isArray(plan.tests)) throw new Error('The generated plan has no case and executable-test records.')
  return plan.cases.some(scenario => !scenario.blockedReason && scenario.requirements?.includes(requirement) &&
    plan.tests.some(test => scenario.testIds?.includes(test.id) && test.bindings?.some(binding =>
      binding.caseId === scenario.caseId && variantKey(binding.variant) === variantKey(scenario.variant))))
}

function packagedExecutable(stamp, previous, context) {
  if (!fs.existsSync(stamp)) throw new Error('Controlled packaging did not produce a provenance record.')
  const serialized = fs.readFileSync(stamp, 'utf8')
  if (serialized === previous) throw new Error('Controlled packaging did not replace the previous provenance record.')
  const record = JSON.parse(serialized)
  const build = readJson(path.join(root, 'out/.acceptance-build.json'))
  if (record.version !== 2) throw new Error('Package provenance lacks the current Electron runtime identity; create a fresh controlled package.')
  if (!record.id || record.build?.id !== build.id || record.platform !== context.platform || record.architecture !== context.architecture) throw new Error('Package provenance does not match the current controlled build and platform.')
  for (const name of [record.directory, record.executable]) {
    if (typeof name !== 'string' || !name || path.isAbsolute(name) || /^[a-z]:[\\/]/i.test(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('The controlled package declares an invalid application path.')
  }
  const directory = path.resolve(root, record.directory)
  const executable = path.resolve(root, record.executable)
  if (!inside(directory, executable) || !inside(fs.realpathSync(root), fs.realpathSync(directory)) || !inside(fs.realpathSync(directory), fs.realpathSync(executable)) || !fs.statSync(executable).isFile()) throw new Error('The controlled application executable is missing or leaves its captured package.')
  return executable
}

let runStarted = false
let outcome = 'failed'
try {
  const context = readJson(path.join(directory, 'context.json'))
  if (git(['rev-parse', 'HEAD']) !== context.revision) throw new Error('The source checkout changed after its identity was captured.')
  if (fs.existsSync(path.join(directory, 'run/run.json'))) throw new Error('This checkout already contains acceptance evidence. Preserve it and use a fresh CI checkout.')
  scope = createEvidenceScope(root, { repository: process.env.GITHUB_REPOSITORY || context.repository, runId: process.env.GITHUB_RUN_ID || `local-${randomUUID()}`, attempt: process.env.GITHUB_RUN_ATTEMPT || '1' })
  environment[evidenceScopeVariable] = scope.path
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  const manifest = path.join(directory, 'manifest.json')
  const plan = path.join(directory, 'plan.json')
  await execute('catalog validation', ['validate'])
  await execute('environment check', ['doctor', '--level', 'e2e', '--json'])
  await execute('test discovery', ['discover', '--output', manifest])
  const args = ['plan', '--profile', context.profile, '--head', context.revision, '--platform', context.platform, '--manifest', manifest, '--output', plan]
  for (const module of context.modules ?? []) args.push('--module', module)
  for (const scenario of context.cases ?? []) args.push('--case', scenario)
  const full = process.env.HALO_ACCEPTANCE_FULL === 'true' || (process.env.GITHUB_EVENT_NAME === 'schedule' && new Date().getUTCDay() === 0)
  const baselineFile = process.env.HALO_ACCEPTANCE_BASELINE
  let reason = full ? 'A complete scheduled or manual sweep was requested.' : 'No restored baseline was supplied.'
  let rerun = []
  if (!full && !context.modules?.length && !context.cases?.length && baselineFile && fs.existsSync(baselineFile)) {
    try {
      const baseline = readJson(baselineFile)
      reason = baselineReason(baseline, context, (base, head) => {
        try { git(['merge-base', '--is-ancestor', base, head]); return true } catch { return false }
      })
      if (!reason) {
        args.push('--base', baseline.revision)
        rerun = failingCaseIds(baseline.results)
        for (const id of rerun) args.push('--rerun-case', id)
      }
    } catch (error) { reason = `Baseline could not be read: ${error.message}` }
  }
  const described = reason ?? `Changes since the last baseline${rerun.length ? `, plus ${rerun.length} scenario${rerun.length === 1 ? '' : 's'} that failed last time` : ''}.`
  console.log(`[Acceptance CI] ${described}`)
  writeEvidenceJson(path.join(directory, 'selection.json'), { full: Boolean(reason), reason: described, rerun }, { exclusive: true, mode: 0o640 })
  await execute('test planning', args)
  const runEnvironment = { ...environment }
  const planned = readJson(plan)
  if (needsRequirement(planned, 'chromium-browser')) await execute('browser preparation', ['browser'], { program: path.join(root, 'scripts/acceptance/ci-prepare.mjs') })
  if (needsRequirement(planned, 'packaged-app')) {
    const stamp = path.join(root, 'out/.acceptance-package.json')
    const previous = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : null
    runEnvironment.HALO_E2E_PACKAGED_APP = await execute('package preparation', ['package', '--timeout-ms', '1800000'], {
      verify: () => packagedExecutable(stamp, previous, context),
    })
  }
  const readinessDirectory = path.join(directory, 'host-readiness-execution')
  if (fs.existsSync(readinessDirectory)) throw new Error('This checkout already contains host-readiness evidence. Preserve it and use a fresh CI checkout.')
  await execute('host readiness', ['doctor', '--level', 'gui', '--json', '--output', readinessDirectory], {
    verify: () => {
      const readiness = readJson(path.join(readinessDirectory, 'readiness.json'))
      if (readiness.version !== 1 || readiness.kind !== 'host-gui-readiness' || readiness.ready !== true || readiness.cleanup?.complete !== true || !['electronConnected', 'appReady', 'windowCreated', 'clickConfirmed'].every(key => readiness.observations?.[key] === true)) throw new Error('The host GUI probe did not establish a ready and cleaned-up graphical session.')
    },
  })
  runStarted = true
  await execute('acceptance execution', ['run', '--plan', plan, '--output', path.join(directory, 'run'), '--timeout-ms', '1800000'], {
    env: runEnvironment, accept: [0, 1, 2], verify: () => completedRun(path.join(directory, 'run/run.json')),
  })
  await execute('report generation', ['report', '--run', path.join(directory, 'run'), '--output', path.join(directory, 'report')])
  outcome = 'passed'
  console.log('[Acceptance CI] Execution finished; finalization must freeze evidence before any baseline can advance.')
} catch (error) {
  console.error(`[Acceptance CI] ${error.message}`)
  if (!interruption && runStarted && fs.existsSync(path.join(directory, 'run/run.json'))) {
    try { await execute('report generation after failure', ['report', '--run', path.join(directory, 'run'), '--output', path.join(directory, 'report')]) }
    catch (reportError) { console.error(`[Acceptance CI] ${reportError.message}`) }
  }
  process.exitCode = 1
} finally {
  if (scope) {
    try { finishEvidenceScope(scope, { outcome: interruption ? 'cancelled' : outcome, exitCode: outcome === 'passed' && !interruption ? 0 : 1, signal: interruption?.signal ?? null }) }
    catch (error) { console.error(`[Acceptance CI] Evidence owner completion failed: ${error.message}`); process.exitCode = 1 }
  }
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onTerminate)
  if (interruption) process.exitCode = 1
}
