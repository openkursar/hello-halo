#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { hash, loadCatalog, readJson, variantsFor, writeJson } from './lib/catalog.mjs'
import { makePlan } from './lib/planner.mjs'
import { discover, prerequisiteFailures, runPlan } from './lib/execution.mjs'
import { changedPaths, resolveCurrentHead, sourceIdentity } from './lib/source.mjs'
import { buildApplication, verifyBuild } from './lib/build.mjs'
import { loadLiveConfig } from './lib/live-config.mjs'
import { packageApplication } from './lib/package.mjs'
import { probeGuiReadiness } from './lib/gui-readiness.mjs'
import { beginEvidenceProducer, finishEvidenceProducer, assertEvidenceOutputWritable } from './lib/ci-evidence.mjs'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const outputRoot = path.join(root, 'tests/acceptance/output')
const command = process.argv[2] ?? 'help'
const { values } = parseArgs({ args: process.argv.slice(3), strict: true, options: {
  help: { type: 'boolean' }, json: { type: 'boolean' },
  output: { type: 'string' }, manifest: { type: 'string' }, plan: { type: 'string' }, run: { type: 'string' },
  profile: { type: 'string', default: 'fast' }, platform: { type: 'string', default: process.platform },
  module: { type: 'string', multiple: true }, case: { type: 'string', multiple: true },
  base: { type: 'string' }, head: { type: 'string', default: 'HEAD' },
  'allow-live': { type: 'boolean' }, 'allow-external': { type: 'boolean' },
  'live-config': { type: 'string' },
  'include-proposed': { type: 'boolean' },
  'timeout-ms': { type: 'string', default: command === 'doctor' ? '15000' : '1800000' }, locale: { type: 'string', default: 'zh' },
  level: { type: 'string', default: 'e2e' }, story: { type: 'string' }, hash: { type: 'string' },
  reviewer: { type: 'string' }, decision: { type: 'string' },
} })

function output(value) { console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }

async function plan(catalog) {
  const manifest = values.manifest ? await readJson(path.resolve(values.manifest)) : await discover(root, catalog, path.join(outputRoot, 'manifest.json'))
  if (manifest.catalogHash !== catalog.hash) throw new Error('The discovery manifest references a different catalog; rediscover tests')
  const revision = await sourceIdentity(root)
  if (hash(manifest.revision) !== hash(revision)) throw new Error('Source or test code changed after discovery; rediscover tests before planning')
  resolveCurrentHead(root, values.head)
  let changed
  if (values.base) {
    try { changed = changedPaths(root, values.base, values.head) }
    catch (error) { console.error(`acceptance: baseline cannot be used; selecting full scope (${error.message.split('\n')[0]})`); changed = null }
  }
  const live = values['allow-live'] ? await loadLiveConfig(values['live-config'] ?? process.env.HALO_ACCEPTANCE_LIVE_CONFIG) : null
  return makePlan(catalog, manifest, { profile: values.profile, platform: values.platform, modules: values.module, cases: values.case, changed, allowLive: values['allow-live'], allowExternal: values['allow-external'], includeProposed: values['include-proposed'], revision, live: live?.public })
}

async function doctor() {
  if (!['catalog', 'gui', 'e2e'].includes(values.level)) throw new Error('--level must be catalog, gui or e2e')
  if (values.level === 'gui') {
    const result = await probeGuiReadiness(root, { outputDirectory: values.output, timeoutMs: Number(values['timeout-ms']) })
    output(result)
    process.exitCode = result.ready ? 0 : 2
    return
  }
  const checks = []
  const check = async (name, operation, required = true) => {
    try { await operation(); checks.push({ name, status: 'ready', required }) }
    catch (error) { checks.push({ name, status: 'unavailable', required, reason: error.message }) }
  }
  await check('node-runtime', () => { if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required') })
  await check('catalog', () => loadCatalog(root))
  await check('temporary-storage', async () => { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-acceptance-')); await fs.rmdir(directory) })
  if (values.level === 'e2e') {
    await check('playwright', () => fs.access(path.join(root, 'node_modules/@playwright/test/cli.js')))
    await check('built-application', async () => { const descriptor = await readJson(path.join(root, 'package.json')); await fs.access(path.resolve(root, descriptor.main)) })
    await check('controlled-build', () => verifyBuild(root))
    await check('halo-sdk', async () => { const errors = await prerequisiteFailures(root, { requirements: ['halo-sdk'] }); if (errors.length) throw new Error(errors.join('; ')) }, false)
  }
  const ready = checks.every(check => !check.required || check.status === 'ready')
  output({ version: 1, ready, platform: process.platform, arch: process.arch, checks })
  process.exitCode = ready ? 0 : 2
}

async function main() {
  if (command === 'help' || command === '--help' || values.help) {
    output('Usage: npm run acceptance -- <validate|catalog|build|package|discover|plan|run|report|doctor|decide> [options]\nSelect --profile fast|regression|live|external, --module ID, --case ID, --base SHA --head SHA.\nLive and external execution require --allow-live / --allow-external.\nPlans, manifests and reports default to tests/acceptance/output. See tests/acceptance/README.md.')
    return
  }
  if (command === 'doctor') return doctor()
  if (command === 'build') {
    const result = await buildApplication(root, { timeoutMs: Number(values['timeout-ms']) })
    output({ buildId: result.id, platform: result.platform, architecture: result.architecture, inputsHash: result.inputs.rootSha256, outputHash: result.artifacts.rootSha256, sdk: result.sdk.state })
    return
  }
  if (command === 'package') {
    const result = await packageApplication(root, { timeoutMs: Number(values['timeout-ms']) })
    output({ packageId: result.id, executable: path.resolve(root, result.executable), contentHash: result.content.rootSha256, coverage: result.coverage })
    return
  }
  const catalog = await loadCatalog(root)
  if (command === 'validate') {
    output({ valid: true, modules: catalog.modules.length, stories: catalog.stories.length, scenarios: catalog.cases.length, variants: catalog.cases.reduce((sum, scenario) => sum + variantsFor(scenario).length, 0), currentApprovals: catalog.approvals.filter(approval => approval.current && approval.decision === 'approved').length, catalogHash: catalog.hash })
  } else if (command === 'catalog') {
    const filename = path.resolve(values.output ?? path.join(outputRoot, 'catalog.json'))
    await writeJson(filename, catalog)
    output({ catalog: filename, stories: catalog.stories.length, scenarios: catalog.cases.length })
  } else if (command === 'discover') {
    const filename = path.resolve(values.output ?? path.join(outputRoot, 'manifest.json'))
    const manifest = await discover(root, catalog, filename)
    output({ manifest: filename, tests: manifest.tests.length, boundTests: manifest.tests.filter(test => test.bindings.length).length })
  } else if (command === 'plan') {
    const value = await plan(catalog)
    const filename = path.resolve(values.output ?? path.join(outputRoot, 'plan.json'))
    await writeJson(filename, value)
    output({ plan: filename, selected: value.cases.length, executable: value.cases.filter(scenario => !scenario.blockedReason).length, reason: value.selectionReason })
  } else if (command === 'run') {
    const value = values.plan ? await readJson(path.resolve(values.plan)) : await plan(catalog)
    const timeoutMs = Number(values['timeout-ms'])
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer')
    const directory = path.resolve(values.output ?? path.join(outputRoot, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`))
    const result = await runPlan(root, catalog, value, directory, { timeoutMs, liveConfigFile: values['live-config'] ?? process.env.HALO_ACCEPTANCE_LIVE_CONFIG })
    output({ run: directory, status: result.status, selected: result.selectedCount, summary: result.summary })
    process.exitCode = result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2
  } else if (command === 'report') {
    const { generateReport } = await import('./lib/report.mjs')
    const runDirectory = values.run ? path.resolve(values.run) : undefined
    const run = runDirectory ? await readJson(path.join(runDirectory, 'run.json')) : null
    const directory = path.resolve(values.output ?? (runDirectory ? path.join(runDirectory, 'report') : path.join(outputRoot, 'site')))
    output(await generateReport(root, catalog, run, directory, { locale: values.locale, runDirectory }))
  } else if (command === 'decide') {
    if (!values.story || !values.hash || !values.reviewer || !['approved', 'rejected'].includes(values.decision)) throw new Error('An explicit human decision requires --story, --hash, --reviewer and --decision approved|rejected')
    const story = catalog.stories.find(story => story.id === values.story)
    if (!story || story.semanticHash !== values.hash) throw new Error('The decision does not match the current story semantic hash')
    const decidedAt = new Date().toISOString()
    const filename = path.join(root, 'tests/acceptance/approvals', `${story.id}-${decidedAt.replace(/[:.]/g, '-')}.json`)
    await writeJson(filename, { version: 1, storyId: story.id, semanticHash: story.semanticHash, decision: values.decision, reviewer: values.reviewer, decidedAt }, { exclusive: true })
    output({ decision: values.decision, storyId: story.id, semanticHash: story.semanticHash })
  } else throw new Error(`Unknown acceptance command: ${command}`)
}

const requestedOutput = values.output ? path.resolve(values.output) : command === 'report' && values.run ? path.join(path.resolve(values.run), 'report') : undefined
assertEvidenceOutputWritable(root, requestedOutput)
const producer = beginEvidenceProducer(root, `cli:${command}`, { self: true })
if (producer) process.once('exit', code => {
  try { finishEvidenceProducer(producer, { exitCode: code }) }
  catch (error) { console.error(`acceptance: evidence producer completion failed: ${error.message}`); if (!code) process.exitCode = 1 }
})
main().catch(error => { console.error(`acceptance: ${error.message}`); process.exitCode = 1 })
