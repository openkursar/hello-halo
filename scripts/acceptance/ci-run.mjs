import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { baselineReason, git, makeBaseline, readJson, writeJson } from './ci-state.mjs'

const root = process.cwd()
const directory = path.join(root, 'tests/acceptance/output/ci')
const cli = path.join(root, 'scripts/acceptance/cli.mjs')
const stages = []
const environment = { ...process.env }
delete environment.HALO_E2E_PACKAGED_APP

function execute(stage, args, { env = environment, verify } = {}) {
  console.log(`[Acceptance CI] Starting ${stage}.`)
  const startedAt = new Date().toISOString()
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, stdio: 'inherit' })
  let value, failure = result.error?.message
  if (!failure && result.status === 0 && verify) {
    try { value = verify() } catch (error) { failure = error.message }
  }
  stages.push({ stage, startedAt, finishedAt: new Date().toISOString(), exitCode: failure ? 1 : result.status, signal: result.signal, error: failure })
  writeJson(path.join(directory, 'stages.json'), stages)
  if (failure || result.status !== 0) throw new Error(`${stage} did not pass (${failure ?? result.signal ?? result.status}).`)
  return value
}

const variantKey = variant => JSON.stringify(Object.entries(variant ?? {}).sort(([left], [right]) => left.localeCompare(right)))
const inside = (parent, file) => { const relative = path.relative(parent, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

function needsPackage(plan) {
  if (!Array.isArray(plan.cases) || !Array.isArray(plan.tests)) throw new Error('The generated plan has no case and executable-test records.')
  return plan.cases.some(scenario => !scenario.blockedReason && scenario.requirements?.includes('packaged-app') &&
    plan.tests.some(test => scenario.testIds?.includes(test.id) && test.bindings?.some(binding =>
      binding.caseId === scenario.caseId && variantKey(binding.variant) === variantKey(scenario.variant))))
}

function packagedExecutable(stamp, previous, context) {
  if (!fs.existsSync(stamp)) throw new Error('Controlled packaging did not produce a provenance record.')
  const serialized = fs.readFileSync(stamp, 'utf8')
  if (serialized === previous) throw new Error('Controlled packaging did not replace the previous provenance record.')
  const record = JSON.parse(serialized)
  const build = readJson(path.join(root, 'out/.acceptance-build.json'))
  if (record.version !== 1 || !record.id || record.build?.id !== build.id || record.platform !== context.platform || record.architecture !== context.architecture) throw new Error('Package provenance does not match the current controlled build and platform.')
  for (const name of [record.directory, record.executable]) {
    if (typeof name !== 'string' || !name || path.isAbsolute(name) || /^[a-z]:[\\/]/i.test(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('The controlled package declares an invalid application path.')
  }
  const directory = path.resolve(root, record.directory)
  const executable = path.resolve(root, record.executable)
  if (!inside(directory, executable) || !inside(fs.realpathSync(root), fs.realpathSync(directory)) || !inside(fs.realpathSync(directory), fs.realpathSync(executable)) || !fs.statSync(executable).isFile()) throw new Error('The controlled application executable is missing or leaves its captured package.')
  return executable
}

let runStarted = false
try {
  const context = readJson(path.join(directory, 'context.json'))
  if (git(['rev-parse', 'HEAD']) !== context.revision) throw new Error('The source checkout changed after its identity was captured.')
  if (fs.existsSync(path.join(directory, 'run/run.json'))) throw new Error('This checkout already contains acceptance evidence. Preserve it and use a fresh CI checkout.')
  const manifest = path.join(directory, 'manifest.json')
  const plan = path.join(directory, 'plan.json')
  execute('catalog validation', ['validate'])
  execute('environment check', ['doctor', '--level', 'e2e', '--json'])
  execute('test discovery', ['discover', '--output', manifest])
  const args = ['plan', '--profile', context.profile, '--head', context.revision, '--platform', context.platform, '--manifest', manifest, '--output', plan]
  for (const module of context.modules ?? []) args.push('--module', module)
  for (const scenario of context.cases ?? []) args.push('--case', scenario)
  const full = process.env.HALO_ACCEPTANCE_FULL === 'true' || (process.env.GITHUB_EVENT_NAME === 'schedule' && new Date().getUTCDay() === 0)
  const baselineFile = process.env.HALO_ACCEPTANCE_BASELINE
  let reason = full ? 'A complete scheduled or manual sweep was requested.' : 'No restored baseline was supplied.'
  if (!full && !context.modules?.length && !context.cases?.length && baselineFile && fs.existsSync(baselineFile)) {
    try {
      const baseline = readJson(baselineFile)
      reason = baselineReason(baseline, context, (base, head) => {
        try { git(['merge-base', '--is-ancestor', base, head]); return true } catch { return false }
      })
      if (!reason) args.push('--base', baseline.revision)
    } catch (error) { reason = `Baseline could not be read: ${error.message}` }
  }
  console.log(`[Acceptance CI] ${reason ?? 'Selecting changes since the last successful validation.'}`)
  writeJson(path.join(directory, 'selection.json'), { full: Boolean(reason), reason: reason ?? 'Changes since the last successful validation.' })
  execute('test planning', args)
  const runEnvironment = { ...environment }
  if (needsPackage(readJson(plan))) {
    const stamp = path.join(root, 'out/.acceptance-package.json')
    const previous = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : null
    runEnvironment.HALO_E2E_PACKAGED_APP = execute('package preparation', ['package', '--timeout-ms', '1800000'], {
      verify: () => packagedExecutable(stamp, previous, context),
    })
  }
  runStarted = true
  execute('acceptance execution', ['run', '--plan', plan, '--output', path.join(directory, 'run'), '--timeout-ms', '1800000'], { env: runEnvironment })
  execute('report generation', ['report', '--run', path.join(directory, 'run'), '--output', path.join(directory, 'report')])
  writeJson(path.join(directory, 'baseline.json'), makeBaseline(context, readJson(path.join(directory, 'run/run.json'))))
  console.log('[Acceptance CI] Every selected instance passed; the baseline is eligible for publication after this workflow succeeds.')
} catch (error) {
  console.error(`[Acceptance CI] ${error.message}`)
  if (runStarted && fs.existsSync(path.join(directory, 'run/run.json'))) {
    try { execute('report generation after failure', ['report', '--run', path.join(directory, 'run'), '--output', path.join(directory, 'report')]) }
    catch (reportError) { console.error(`[Acceptance CI] ${reportError.message}`) }
  }
  process.exitCode = 1
}
