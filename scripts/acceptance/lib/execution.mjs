import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hash, instanceKey, readJson, writeJson } from './catalog.mjs'
import { sourceIdentity } from './source.mjs'
import { makePlan, validateManifest } from './planner.mjs'
import { execute, redact } from './process.mjs'
import { verifyBuild } from './build.mjs'
import { loadLiveConfig } from './live-config.mjs'
import { startLiveBroker } from './live-broker.mjs'
import { discoverClusterTests, executeClusterTests } from '../adapters/cluster.mjs'
import { verifyPackagedApplication } from './package.mjs'
import { macClipboardFailure } from './clipboard-readiness.mjs'
export { execute } from './process.mjs'

export function cleanEnvironment(source = process.env) {
  const environment = { ...source, HALO_ACCEPTANCE_MODE: 'deterministic', HALO_E2E_PACKAGED_APP: undefined }
  for (const key of Object.keys(environment)) {
    // Git's counted configuration must be removed together, not with only its KEY entries blanked.
    if (key.startsWith('GIT_CONFIG_')) environment[key] = undefined
    else if (key.startsWith('HALO_TEST_') || /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL|COOKIE/i.test(key)) environment[key] = ''
  }
  return environment
}

export async function readEvents(filename) {
  const content = await fs.readFile(filename, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return content.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) } catch { throw new Error(`Invalid test event at line ${index + 1}`) }
  })
}

export async function discover(root, catalog, output) {
  const directory = path.join(root, 'tests/acceptance/output/discovery', randomUUID())
  await fs.mkdir(directory, { recursive: true })
  const eventFile = path.join(directory, 'events.jsonl')
  const result = await execute(root, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright.config.ts', '--list', '--reporter', './scripts/acceptance/playwright-reporter.ts'], {
    environment: { ...cleanEnvironment(), HALO_ACCEPTANCE_ROOT: root, HALO_ACCEPTANCE_REPORT: eventFile },
    timeoutMs: 120000, logFile: path.join(directory, 'discovery.log'),
  })
  const events = await readEvents(eventFile)
  const begin = events.find(event => event.type === 'begin')
  const errors = events.filter(event => event.type === 'error')
  if (result.code !== 0 || !begin || errors.length) throw new Error(`Test discovery failed: ${errors.map(event => event.message).join('; ') || result.log.slice(-4000)}`)
  const clusterTests = await discoverClusterTests(root)
  const manifest = { version: 1, catalogHash: catalog.hash, revision: await sourceIdentity(root), tests: [...begin.tests, ...clusterTests] }
  validateManifest(catalog, manifest)
  if (output) await writeJson(output, manifest)
  return manifest
}

export function summarizeCases(cases) {
  const summary = Object.fromEntries(['passed', 'failed', 'flaky', 'skipped', 'blocked', 'not-run', 'manual'].map(status => [status, 0]))
  for (const scenario of cases) summary[scenario.status]++
  return summary
}

export function executionBatches(tests, maximum = 8192) {
  const batches = []
  let batch = [], size = 0
  for (const test of tests) {
    const cost = Buffer.byteLength(test.titlePath.join(' ') + test.file + test.project) * 2 + 64
    if (cost > maximum) throw new Error(`Test identity exceeds the command-line selection limit: ${test.id}`)
    if (batch.length && size + cost > maximum) { batches.push(batch); batch = []; size = 0 }
    batch.push(test); size += cost
  }
  if (batch.length) batches.push(batch)
  return batches
}

export function executionGroups(tests, cases) {
  const groups = new Map()
  for (const test of tests) {
    const selected = cases.filter(scenario => !scenario.blockedReason && scenario.testIds.includes(test.id) && test.bindings.some(binding => instanceKey(binding.caseId, binding.variant) === instanceKey(scenario.caseId, scenario.variant)))
    if (!selected.length) throw new Error(`Executable test has no eligible selected binding: ${test.id}`)
    const executor = test.executor ?? 'playwright'
    const packaged = selected.some(scenario => scenario.requirements?.includes('packaged-app'))
    if (executor === 'cluster' && packaged) throw new Error('Cluster execution cannot fulfill a packaged-app requirement')
    const host = executor === 'cluster' ? 'cluster' : packaged ? 'packaged' : 'source'
    const mode = test.bindings.some(binding => binding.mode === 'live') ? 'live' : 'deterministic'
    const key = `${mode}-${host}`
    if (!groups.has(key)) groups.set(key, { mode, executor, host, tests: [] })
    groups.get(key).tests.push(test)
  }
  return ['deterministic-source', 'deterministic-packaged', 'deterministic-cluster', 'live-source', 'live-packaged', 'live-cluster'].flatMap(key => groups.has(key) ? [groups.get(key)] : [])
}

export function collectResults(plan, events, execution) {
  const testResults = new Map()
  for (const event of events.filter(event => event.type === 'test')) {
    const attempts = testResults.get(event.id) ?? []
    attempts.push(event)
    testResults.set(event.id, attempts)
  }
  return plan.cases.map(scenario => {
    const attempts = scenario.testIds.flatMap(id => testResults.get(id) ?? [])
    const invalidBinding = attempts.some(attempt => {
      const expected = plan.tests?.find(test => test.id === attempt.id)
      return !expected || hash(expected.bindings) !== hash(attempt.bindings)
    })
    let status, reason
    if (scenario.automation === 'manual') { status = 'manual'; reason = scenario.blockedReason }
    else if (scenario.blockedReason) { status = 'blocked'; reason = scenario.blockedReason }
    else if (invalidBinding) { status = 'not-run'; reason = 'Actual test bindings differ from the planned scenario; results cannot establish verification' }
    else if (!attempts.length || scenario.testIds.some(id => !testResults.has(id))) { status = 'not-run'; reason = execution.timedOut ? 'The run exceeded its time budget' : 'Required test results were not produced' }
    else {
      const last = scenario.testIds.map(id => testResults.get(id).at(-1))
      if (last.some(attempt => ['failed', 'timedOut', 'interrupted'].includes(attempt.status))) status = 'failed'
      else if (last.some(attempt => attempt.status === 'skipped')) { status = 'skipped'; reason = 'A required test was skipped; this is not verification' }
      else if (last.every(attempt => attempt.status === 'passed')) status = attempts.some(attempt => attempt.status !== 'passed') ? 'flaky' : 'passed'
      else { status = 'not-run'; reason = 'Unrecognized or incomplete test outcome' }
    }
    return { ...scenario, status, ...(reason ? { reason } : {}), attempts }
  })
}

export function verifyLiveEvidence(cases, usage) {
  return cases.map(scenario => {
    if (scenario.mode !== 'live' || scenario.status !== 'passed') return scenario
    const receipts = []
    for (const testId of scenario.testIds) {
      const attempt = scenario.attempts.findLast(value => value.id === testId)
      if (!attempt?.isolation?.some(value => ['brokered-fresh-profile', 'brokered-cluster-profile'].includes(value))) return { ...scenario, status: 'not-run', reason: 'The live test did not establish an isolated brokered application profile', modelReceipts: receipts }
      const start = Date.parse(attempt?.startedAt)
      const end = attempt?.finishedAt ? Date.parse(attempt.finishedAt) : start + Number(attempt?.duration)
      const matches = (usage?.requests ?? []).filter(request => {
        const at = Date.parse(request.startedAt)
        return Number.isFinite(start) && Number.isFinite(end) && at >= start - 10 && at <= end + 10 && request.upstreamStatus >= 200 && request.upstreamStatus < 300 && request.responseBytes > 0
      })
      if (!matches.length) return { ...scenario, status: 'not-run', reason: 'The passing test has no matching brokered model response; live-model evidence is not established', modelReceipts: receipts }
      receipts.push({ testId, scope: attempt.timingScope ?? 'test', requests: matches.map(request => request.sequence) })
    }
    return { ...scenario, modelReceipts: receipts }
  })
}

export async function terminalShellFailure({ platform = process.platform, environment = process.env,
  access = fs.access.bind(fs), stat = fs.stat.bind(fs), run = promisify(execFile),
} = {}) {
  if (!['darwin', 'win32'].includes(platform)) return 'The interactive terminal requires macOS or Windows; this host is unsupported'
  let executable = '/bin/bash'
  const label = platform === 'darwin' ? 'The fixed macOS /bin/bash shell' : 'Windows PowerShell at the SystemRoot/WINDIR system path'
  if (platform === 'win32') {
    const systemRoot = environment.SystemRoot || environment.WINDIR
    if (typeof systemRoot !== 'string' || !/^[a-z]:[\\/]/i.test(systemRoot) || /[\0\r\n]/.test(systemRoot)) {
      return 'Windows terminal readiness requires an absolute local SystemRoot or WINDIR directory'
    }
    executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }
  try {
    if (!(await stat(executable)).isFile()) return `${label} is not a regular executable file`
    await access(executable, platform === 'darwin' ? fsConstants.X_OK : fsConstants.F_OK)
    if (platform === 'win32') {
      const receipt = 'HALO_ACCEPTANCE_POWERSHELL_READY'
      const result = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::Out.Write('${receipt}')`], {
        timeout: 3000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true, shell: false,
      })
      if (result.stdout.trim() !== receipt) return 'Windows PowerShell did not return its read-only startup receipt'
    }
    return null
  } catch (error) {
    const code = typeof error.code === 'string' && /^(?:E[A-Z0-9_]{1,40}|ERR_[A-Z0-9_]{1,60})$/.test(error.code)
      ? error.code : Number.isInteger(error.code) ? `exit ${error.code}` : 'unavailable'
    return `${label} is unavailable (${error.killed ? 'startup timeout' : code})`
  }
}

export async function prerequisiteFailures(root, scenario, { liveReady = false, clipboardProbe = macClipboardFailure } = {}) {
  const problems = []
  if (scenario.mode === 'live' && !liveReady) problems.push('Live execution requires an explicit, credentialed budget broker configuration')
  for (const requirement of scenario.requirements ?? []) {
    if (requirement === 'halo-sdk') {
      try {
        const directory = path.join(root, 'node_modules/@hello-halo/agent-sdk')
        const descriptor = await readJson(path.join(directory, 'package.json'))
        const entry = descriptor.exports?.['.']?.import ?? descriptor.module ?? descriptor.main
        if (typeof entry !== 'string') throw new Error('SDK import entry is missing')
        await fs.access(path.resolve(directory, entry))
      } catch { problems.push('The application engine SDK import entry is not installed or built') }
    } else if (requirement === 'packaged-app') {
      if (!process.env.HALO_E2E_PACKAGED_APP) problems.push('A packaged application was not supplied through HALO_E2E_PACKAGED_APP')
      else await fs.access(process.env.HALO_E2E_PACKAGED_APP).catch(() => problems.push('The supplied packaged application does not exist'))
    } else if (requirement === 'live-model') {
      if (scenario.mode !== 'live') problems.push('Live model prerequisites require live execution mode')
    } else if (requirement === 'windows-tools') {
      if (process.platform !== 'win32') problems.push('This scenario requires actual Windows execution')
    } else if (requirement === 'terminal-shell') {
      const missing = await terminalShellFailure()
      if (missing) problems.push(missing)
    } else if (requirement === 'mac-clipboard') {
      const missing = await clipboardProbe(root)
      if (missing) problems.push(missing)
    } else if (requirement === 'chromium-browser') {
      try {
        const { chromium } = await import('playwright')
        await fs.access(chromium.executablePath())
      } catch { problems.push('Install the matching Chromium browser with playwright install chromium') }
    } else if (requirement === 'file-symlinks') {
      let directory
      try {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-acceptance-file-link-'))
        const target = path.join(directory, 'target.txt'), link = path.join(directory, 'link.txt')
        await fs.writeFile(target, 'acceptance file-link probe')
        await fs.symlink(target, link, 'file')
        if (await fs.realpath(link) !== await fs.realpath(target) || await fs.readFile(link, 'utf8') !== 'acceptance file-link probe') throw new Error('The temporary file-link probe did not resolve to its own target')
      } catch (error) {
        problems.push(`File symbolic-link creation and reading are unavailable (${error.code ?? 'verification-failed'})`)
      } finally {
        if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(error => {
          problems.push(`Temporary file-link probe cleanup failed (${error.code ?? 'unknown'})`)
        })
      }
    } else if (requirement === 'local-claude-code') {
      if (!process.env.HALO_ACCEPTANCE_CLAUDE_CLI) problems.push('A separately installed external command-line engine was not configured')
      else await fs.access(process.env.HALO_ACCEPTANCE_CLAUDE_CLI).catch(() => problems.push('The configured external command-line engine does not exist'))
    } else if (['external-im', 'native-dialog', 'multi-host', 'signing', 'mobile-device', 'test-registry', 'test-mail-account'].includes(requirement)) {
      if (!process.env[`HALO_ACCEPTANCE_${requirement.replaceAll('-', '_').toUpperCase()}`]) problems.push(`The ${requirement} environment has not been configured`)
    } else problems.push(`No readiness check is registered for prerequisite: ${requirement}`)
  }
  return problems
}

export async function runPlan(root, catalog, plan, output, { timeoutMs = 1800000, liveConfigFile } = {}) {
  if (plan.version !== 1 || !Array.isArray(plan.cases) || !Array.isArray(plan.tests)) throw new Error('Unsupported execution plan')
  if (plan.catalogHash !== catalog.hash) throw new Error('The catalog changed after planning; generate a new plan')
  const revision = await sourceIdentity(root)
  if (hash(revision) !== hash(plan.revision)) throw new Error('Source or test code changed after planning; generate a new plan')
  if (plan.platform !== process.platform) throw new Error(`Plan requires ${plan.platform}, but this machine is ${process.platform}`)
  if (!plan.selection) throw new Error('The execution plan does not record its selection inputs')
  const manifest = await discover(root, catalog)
  if (hash(manifest) !== plan.manifestHash) throw new Error('The executable test manifest changed after planning; generate a new plan')
  const expected = makePlan(catalog, manifest, { ...plan.selection, changed: plan.selection.includeCore ? plan.selection.changed : undefined, profile: plan.profile, platform: plan.platform, allowLive: plan.allowLive, allowExternal: plan.allowExternal, revision, live: plan.live })
  if (hash({ cases: expected.cases, tests: expected.tests, excluded: expected.excluded }) !== hash({ cases: plan.cases, tests: plan.tests, excluded: plan.excluded })) throw new Error('Plan cases or executable bindings do not match the catalog and selection inputs')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.mkdir(output)
  const startedAt = new Date().toISOString()
  const actual = structuredClone(plan)
  let liveConfig, liveProblem
  if (plan.allowLive && plan.cases.some(scenario => scenario.mode === 'live')) {
    try {
      liveConfig = await loadLiveConfig(liveConfigFile, { requireCredential: true })
      if (!liveConfig || !plan.live || hash(liveConfig.public) !== hash(plan.live)) throw new Error('Live configuration or budget differs from the plan; plan again with --live-config')
    } catch (error) { liveProblem = error.message; liveConfig = null }
  }
  for (const scenario of actual.cases) {
    const missing = await prerequisiteFailures(root, scenario, { liveReady: Boolean(plan.allowLive && liveConfig) })
    if (scenario.mode === 'live' && liveProblem) missing.push(liveProblem)
    if (missing.length) scenario.blockedReason = [scenario.blockedReason, ...missing].filter(Boolean).join('; ')
  }
  const selected = actual.tests.filter(test => actual.cases.some(scenario => !scenario.blockedReason && scenario.testIds.includes(test.id)))
  const eventFile = path.join(output, 'playwright-events.jsonl')
  let execution = { code: null, timedOut: false, log: '' }, events = [], buildIdentity = null, packageIdentity = null, broker = null, liveUsage = null
  const batchRecords = []
  const baseRecord = { version: 1, id: path.basename(output), startedAt, revision, catalogHash: catalog.hash, manifestHash: plan.manifestHash, profile: plan.profile, platform: plan.platform, selection: plan.selection, selectionReason: plan.selectionReason, selectedCount: plan.cases.length, excluded: plan.excluded }
  await writeJson(path.join(output, 'plan.json'), actual, { exclusive: true })
  await writeJson(path.join(output, 'in-progress.json'), { ...baseRecord, pid: process.pid }, { exclusive: true })
  try {
    if (selected.length) {
      const build = await verifyBuild(root)
      buildIdentity = { id: build.id, builtAt: build.builtAt, inputsHash: build.inputs.rootSha256, artifactsHash: build.artifacts.rootSha256, sdk: build.sdk, platform: build.platform, architecture: build.architecture, node: build.node }
      await writeJson(path.join(output, 'build.json'), build, { exclusive: true })
      const deadline = Date.now() + timeoutMs
      const invocations = []
      const batches = executionGroups(selected, actual.cases).flatMap(group => {
        const selections = group.executor === 'cluster' ? [group.tests] : executionBatches(group.tests)
        return selections.map((tests, index) => ({ ...group, tests, id: `${group.mode}-${group.host}-${index}` }))
      })
      for (const batch of batches) batchRecords.push({ id: batch.id, executor: batch.executor, mode: batch.mode, testIds: batch.tests.map(test => test.id), executionHost: { kind: batch.host, buildId: build.id }, status: 'not-run' })
      const saveBatches = () => writeJson(path.join(output, 'execution-batches.json'), batchRecords)
      await saveBatches()
      let rawEvents = []
      const captureBatchEvents = async batch => {
        const recorded = await readEvents(eventFile)
        if (hash(recorded.slice(0, rawEvents.length)) !== hash(rawEvents)) throw new Error('Previously recorded runner events changed during execution')
        const added = recorded.slice(rawEvents.length)
        rawEvents = recorded
        for (const event of added) {
          if (event.type === 'test') {
            if (!batch.testIds.includes(event.id)) events.push({ type: 'error', message: `The runner executed a test outside its selected runtime batch: ${event.id}` })
            events.push({ ...event, executionHost: { ...batch.executionHost, batchId: batch.id } })
          } else events.push(event)
        }
        return added
      }
      let verifiedPackage = null
      for (const [index, batch] of batches.entries()) {
        const record = batchRecords[index]
        if (Date.now() >= deadline) { invocations.push({ code: 1, timedOut: true, log: 'The shared run time budget was exhausted before this batch' }); record.reason = 'The shared run time budget was exhausted'; break }
        const environment = cleanEnvironment()
        if (batch.mode === 'live') {
          if (!liveConfig) throw new Error('Live tests cannot run without a budget broker')
          broker ??= await startLiveBroker({ ...liveConfig.config, apiKey: liveConfig.apiKey })
          environment[liveConfig.config.apiKeyEnv] = ''
          Object.assign(environment, { HALO_ACCEPTANCE_MODE: 'brokered-live', HALO_TEST_API_URL: broker.url, HALO_TEST_API_KEY: broker.clientKey, HALO_TEST_MODEL: liveConfig.config.model, HALO_TEST_PROVIDER: liveConfig.config.protocol })
        }
        if (batch.host === 'packaged') {
          verifiedPackage ??= await verifyPackagedApplication(root, process.env.HALO_E2E_PACKAGED_APP)
          environment.HALO_E2E_PACKAGED_APP = path.resolve(root, verifiedPackage.executable)
        }
        if (Date.now() >= deadline) { invocations.push({ code: 1, timedOut: true, log: 'The shared run time budget was exhausted while preparing the runtime' }); record.reason = 'The shared run time budget was exhausted'; break }
        record.startedAt = new Date().toISOString()
        record.status = 'running'
        await saveBatches()
        let invocation
        try {
          if (batch.executor === 'cluster') {
            invocation = await executeClusterTests(root, batch.tests, { outputDirectory: output, eventFile, environment, timeoutMs: Math.max(1, deadline - Date.now()) })
          } else {
            const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const grep = batch.tests.map(test => `(?:^| )${escape(test.titlePath.join(' '))}$`).join('|')
            const selectionFile = path.join(output, `selection-${batch.id}.json`)
            await writeJson(selectionFile, batch.tests, { exclusive: true })
            const args = ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright.config.ts', ...new Set(batch.tests.map(test => test.file)), ...[...new Set(batch.tests.map(test => test.project))].flatMap(project => [`--project=${project}`]), '--grep', grep, '--workers', '1', '--retries', '0', '--reporter', './scripts/acceptance/playwright-reporter.ts', '--output', path.join(output, 'artifacts', batch.id)]
            invocation = await execute(root, args, { environment: { ...environment, HALO_ACCEPTANCE_ROOT: root, HALO_ACCEPTANCE_REPORT: eventFile, HALO_ACCEPTANCE_SELECTION_FILE: selectionFile }, timeoutMs: Math.max(1, deadline - Date.now()), logFile: path.join(output, `runner-${batch.id}.log`) })
          }
          invocations.push(invocation)
          if (batch.host === 'packaged') record.executionHost.packageId = verifiedPackage.id
          if (batch.host === 'packaged' && !packageIdentity) {
            packageIdentity = { id: verifiedPackage.id, packagedAt: verifiedPackage.packagedAt, contentHash: verifiedPackage.content.rootSha256, executable: verifiedPackage.executable, coverage: verifiedPackage.coverage }
            await writeJson(path.join(output, 'package.json'), verifiedPackage, { exclusive: true })
          }
          record.exitCode = invocation.code
          record.timedOut = invocation.timedOut
          record.cleanupFailed = Boolean(invocation.cleanupFailed)
          record.status = invocation.code === 0 ? 'completed' : 'failed'
          const added = await captureBatchEvents(record)
          if (invocation.code === 0 && (!added.some(event => event.type === 'begin') || added.findLast(event => event.type === 'end')?.status !== 'passed')) {
            invocation.code = 1
            record.status = 'failed'
            record.error = 'The runner completed without a successful terminal batch record'
            events.push({ type: 'error', message: record.error })
          }
          if (invocation.cleanupFailed) {
            events.push({ type: 'error', message: 'An execution batch could not confirm cleanup; remaining batches were not started' })
            break
          }
        } catch (error) {
          record.status = 'failed'
          record.error = redact(error.message, root)
          try { await captureBatchEvents(record) } catch (readError) { events.push({ type: 'error', message: redact(readError.message, root) }) }
          throw error
        } finally {
          record.finishedAt = new Date().toISOString()
          await saveBatches()
        }
      }
      await saveBatches()
      execution = { code: invocations.some(result => result.code !== 0) ? 1 : 0, timedOut: invocations.some(result => result.timedOut), log: invocations.map(result => result.log).join('\n') }
      await fs.writeFile(path.join(output, 'runner.log'), execution.log)
      await verifyBuild(root)
      if (packageIdentity) await verifyPackagedApplication(root, process.env.HALO_E2E_PACKAGED_APP)
    }
  } catch (error) {
    execution = { code: 1, timedOut: false, log: redact(error.stack ?? error.message, root) }
    events.push({ type: 'error', message: redact(error.message, root) })
    await fs.writeFile(path.join(output, 'runner.log'), execution.log)
  } finally {
    if (broker) { await broker.close(); liveUsage = broker.summary(); await writeJson(path.join(output, 'live-usage.json'), liveUsage, { exclusive: true }) }
  }
  const errors = events.filter(event => event.type === 'error').map(event => event.message)
  try {
    if (hash(await sourceIdentity(root)) !== hash(revision)) errors.push('Source or test code changed during execution; results are diagnostic only')
  } catch (error) {
    errors.push(`Source identity could not be verified after execution: ${redact(error.message, root)}`)
  }
  const unexpected = events.filter(event => event.type === 'test' && !selected.some(test => test.id === event.id))
  if (unexpected.length) errors.push('The runner executed tests outside the approved plan')
  const evidenceIntegrity = { version: 1, valid: errors.length === 0, reasons: errors }
  const cases = verifyLiveEvidence(collectResults(actual, events, execution), liveUsage).map(scenario => {
    if (evidenceIntegrity.valid || scenario.status !== 'passed') return scenario
    return { ...scenario, status: 'not-run', reason: 'Run evidence integrity failed; recorded attempts are diagnostic only' }
  })
  if (!evidenceIntegrity.valid) console.error(`acceptance: run evidence is diagnostic only: ${errors.join('; ')}`)
  const summary = summarizeCases(cases)
  const end = events.findLast(event => event.type === 'end')
  const runnerFailed = selected.length && (execution.code !== 0 || !end || end.status !== 'passed')
  const status = summary.failed || errors.length ? 'failed' : !cases.length || summary.passed !== cases.length || runnerFailed ? 'incomplete' : 'passed'
  const result = { ...baseRecord, buildIdentity, packageIdentity, executionBatches: batchRecords, evidenceIntegrity, live: plan.live ?? null, liveUsage, finishedAt: new Date().toISOString(), status, summary, cases, errors, runner: { code: execution.code, timedOut: execution.timedOut, status: end?.status ?? 'not-started' } }
  await writeJson(path.join(output, 'run.json'), result, { exclusive: true })
  await fs.unlink(path.join(output, 'in-progress.json'))
  return result
}
