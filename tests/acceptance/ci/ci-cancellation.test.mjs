import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { fixture, evidence, source, finalizer } from './fixtures/ci-application.mjs'
import { verifyEvidenceSource } from '../../../scripts/acceptance/lib/ci-evidence.mjs'
import { archiveCi } from '../../../scripts/acceptance/ci-archive.mjs'

const identity = { repository: 'example/controller', runId: '100', attempt: '1' }
const posix = process.platform !== 'win32'
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
// The fixture writes its records in place, so existence alone can mean a partial file.
const readable = file => { try { read(file); return true } catch { return false } }

async function until(check) {
  const deadline = Date.now() + 7000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('The owned CI process did not reach its expected state')
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

function runningFixture(t, options) {
  const cleanups = []
  const selected = fixture({ after: cleanup => cleanups.push(cleanup) }, options)
  const owner = selected.start()
  let logs = ''
  owner.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-20000) })
  owner.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-20000) })
  const closed = once(owner, 'close')
  const exited = once(owner, 'exit')
  t.after(async () => {
    const ready = path.join(selected.directory, 'stage-ready.json')
    if (fs.existsSync(ready)) {
      const { pid } = read(ready)
      try {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        if (command.includes(path.join(selected.root, 'scripts/acceptance/cli.mjs'))) process.kill(-pid, 'SIGKILL')
      } catch (error) { if (error.code !== 'ESRCH' && error.status !== 1) throw error }
    }
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
    await closed
    for (const cleanup of cleanups) await cleanup()
  })
  return { ...selected, owner, closed, exited, logs: () => logs }
}

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} cancels the CI owner even when its real stage child exits zero`, { skip: !posix, timeout: 15000 }, async t => {
  const selected = runningFixture(t, { hangCommand: 'package', cooperativeExit: true })
  const control = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const controlClosed = once(control, 'close')
  t.after(async () => { if (control.exitCode === null && control.signalCode === null) control.kill('SIGKILL'); await controlClosed })
  await until(() => readable(path.join(selected.directory, 'stage-ready.json')) && fs.existsSync(path.join(selected.directory, 'active-writer.log')))
  assert.equal(read(path.join(selected.directory, 'stages.json')).at(-1).status, 'running')
  selected.owner.kill(signal)
  const [code] = await selected.closed
  assert.notEqual(code, 0, selected.logs())
  const { stages, calls } = evidence(selected)
  assert.equal(stages.at(-1).status, 'cancelled')
  assert.equal(stages.at(-1).processExitCode, 0)
  assert.equal(stages.at(-1).interruption.signal, signal)
  assert.equal(calls.some(call => call.command === 'run' || call.command === 'report'), false)
  process.kill(control.pid, 0)
  const before = fs.readFileSync(path.join(selected.directory, 'active-writer.log'))
  const finalization = selected.finalize('cancelled')
  assert.equal(finalization.status, 0, finalization.stderr)
  assert.equal(verifyEvidenceSource(selected.root, { identity }).receipt.completion.outcome, 'cancelled')
  assert.equal(evidence(selected).baseline, false)
  assert.deepEqual(fs.readFileSync(path.join(selected.directory, 'active-writer.log')), before)
})

test('SIGKILL of the CI owner leaves a nonfinal snapshot while its independently grouped writer is alive', { skip: !posix, timeout: 15000 }, async t => {
  const selected = runningFixture(t, { hangCommand: 'package' })
  await until(() => readable(path.join(selected.directory, 'stage-ready.json')))
  const writer = read(path.join(selected.directory, 'stage-ready.json')).pid
  selected.owner.kill('SIGKILL')
  await selected.exited
  process.kill(writer, 0)
  assert.equal(selected.finalize('cancelled').status, 1)
  assert.equal(fs.existsSync(path.join(selected.directory, 'evidence-freeze.json')), false)
  assert.equal(read(path.join(selected.directory, 'stages.json')).at(-1).status, 'running')
  assert.equal(evidence(selected).baseline, false)
  let archiveError
  try { archiveCi({ checkout: selected.root, archiveRoot: path.join(path.dirname(selected.root), path.basename(selected.root) + '-archive'), identity }) }
  catch (error) { archiveError = error }
  assert(archiveError)
  assert(archiveError.archiveDirectory)
  t.after(() => fs.rmSync(path.dirname(archiveError.archiveDirectory), { recursive: true, force: true }))
  assert.equal(fs.existsSync(path.join(archiveError.archiveDirectory, 'COMPLETE.json')), false)
  process.kill(writer, 0)
})

test('a frozen result cannot be rewritten by summary or a second finalization', t => {
  const selected = fixture(t)
  const result = selected.run()
  assert.equal(result.status, 0, result.stderr)
  const summary = fs.readFileSync(path.join(selected.directory, 'summary.md'))
  const freeze = fs.readFileSync(path.join(selected.directory, 'evidence-freeze.json'))
  const script = fileURLToPath(new URL('../../../scripts/acceptance/ci-state.mjs', import.meta.url))
  const late = spawnSync(process.execPath, [script, 'summary'], { cwd: selected.root, encoding: 'utf8', env: selected.environment() })
  assert.equal(late.status, 1)
  assert.match(late.stderr, /Frozen CI evidence/)
  assert.equal(selected.finalize('success').status, 1)
  assert.deepEqual(fs.readFileSync(path.join(selected.directory, 'summary.md')), summary)
  assert.deepEqual(fs.readFileSync(path.join(selected.directory, 'evidence-freeze.json')), freeze)
  verifyEvidenceSource(selected.root, { identity })
})

for (const name of ['selection.json', 'summary.md']) test(`a redirected ${name} is rejected before any external bytes are overwritten`, t => {
  const selected = fixture(t)
  const external = path.join(selected.root, 'external-sentinel')
  fs.writeFileSync(external, 'existing external evidence')
  const destination = path.join(selected.directory, name)
  if (name === 'selection.json') fs.symlinkSync(external, destination)
  const owner = spawnSync(process.execPath, [source], { cwd: selected.root, env: selected.environment(), encoding: 'utf8', timeout: 20000 })
  if (name === 'summary.md') {
    assert.equal(owner.status, 0, owner.stderr)
    fs.symlinkSync(external, destination)
  } else assert.equal(owner.status, 1)
  assert.equal(selected.finalize(owner.status ? 'failure' : 'success').status, 1)
  assert.equal(fs.readFileSync(external, 'utf8'), 'existing external evidence')
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true)
  assert.equal(fs.existsSync(path.join(selected.directory, 'evidence-freeze.json')), false)
  assert.equal(evidence(selected).baseline, false)
})

test('legacy metadata commands cannot write after the execution owner has registered', t => {
  const selected = fixture(t)
  const owner = spawnSync(process.execPath, [source], { cwd: selected.root, env: selected.environment(), encoding: 'utf8', timeout: 20000 })
  assert.equal(owner.status, 0, owner.stderr)
  const context = fs.readFileSync(path.join(selected.directory, 'context.json'))
  const script = fileURLToPath(new URL('../../../scripts/acceptance/ci-state.mjs', import.meta.url))
  for (const command of ['context', 'summary']) {
    const late = spawnSync(process.execPath, [script, command], { cwd: selected.root, encoding: 'utf8', env: selected.environment() })
    assert.equal(late.status, 1)
    assert.match(late.stderr, /metadata writes are closed/)
  }
  assert.deepEqual(fs.readFileSync(path.join(selected.directory, 'context.json')), context)
  assert.equal(fs.existsSync(path.join(selected.directory, 'summary.md')), false)
  assert.equal(selected.finalize('success').status, 0)
  verifyEvidenceSource(selected.root, { identity })
})

for (const state of ['missing', 'invalid']) test(`an early ${state} context produces a scoped job summary without mutating evidence`, t => {
  const selected = fixture(t)
  const contextFile = path.join(selected.directory, 'context.json')
  if (state === 'missing') fs.unlinkSync(contextFile)
  else fs.writeFileSync(contextFile, '{invalid-context')
  const external = path.join(selected.root, 'external-evidence')
  fs.writeFileSync(external, 'existing external bytes')
  const payloadSummary = path.join(selected.directory, 'summary.md')
  fs.symlinkSync(external, payloadSummary)
  const before = fs.readdirSync(selected.directory).sort()
  const summary = path.join(selected.root, 'job-summary.md')
  const outputs = path.join(selected.root, 'job-outputs')
  const result = spawnSync(process.execPath, [finalizer], { cwd: selected.root, encoding: 'utf8', env: {
    ...selected.environment(), HALO_SOURCE_REPOSITORY: 'example/application', HALO_SOURCE_REF: 'main', HALO_ACCEPTANCE_PROFILE: 'regression',
    HALO_CI_STAGE_OUTCOMES: JSON.stringify({ sdk: { outcome: 'failure' }, build: { outcome: 'skipped' }, execute: { outcome: 'skipped' } }), GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs,
  } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /context is unavailable or unreadable/)
  const body = fs.readFileSync(summary, 'utf8')
  assert.match(body, /example\/application.*main/)
  assert.match(body, /\| sdk \| failure \|/)
  assert.match(body, /\| execute \| skipped \|/)
  assert.match(body, /No cases are claimed as passing/)
  assert.match(body, /no freeze or baseline is eligible/)
  assert.equal(fs.existsSync(outputs), false)
  assert.deepEqual(fs.readdirSync(selected.directory).sort(), before)
  assert.equal(fs.lstatSync(payloadSummary).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(external, 'utf8'), 'existing external bytes')
  if (state === 'invalid') assert.equal(fs.readFileSync(contextFile, 'utf8'), '{invalid-context')
  assert.equal(fs.existsSync(path.join(selected.root, 'tests/acceptance/output/ci-baseline')), false)
})

test('an unavailable context cannot redirect its job-summary fallback into the evidence payload', t => {
  const selected = fixture(t)
  fs.unlinkSync(path.join(selected.directory, 'context.json'))
  const target = path.join(selected.directory, 'summary.md')
  fs.writeFileSync(target, 'preserved partial evidence')
  const result = spawnSync(process.execPath, [finalizer], { cwd: selected.root, encoding: 'utf8', env: { ...selected.environment(), GITHUB_STEP_SUMMARY: target } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /job summary must be separate/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserved partial evidence')
  assert.deepEqual(fs.readdirSync(selected.directory), ['summary.md'])
})

test('a completed owner with malformed run bytes produces only an unreadable-evidence job summary', t => {
  const selected = fixture(t)
  const owner = spawnSync(process.execPath, [source], { cwd: selected.root, encoding: 'utf8', env: selected.environment(), timeout: 20000 })
  assert.equal(owner.status, 0, owner.stderr)
  const runFile = path.join(selected.directory, 'run/run.json')
  fs.writeFileSync(runFile, '{incomplete-run')
  const payloadSummary = path.join(selected.directory, 'summary.md')
  fs.writeFileSync(payloadSummary, 'preserved partial summary')
  const before = fs.readdirSync(selected.directory).sort()
  const summary = path.join(selected.root, 'job-summary.md')
  const result = spawnSync(process.execPath, [finalizer], { cwd: selected.root, encoding: 'utf8', env: { ...selected.environment(), GITHUB_STEP_SUMMARY: summary } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /completed run record is unreadable/)
  const body = fs.readFileSync(summary, 'utf8')
  assert.match(body, /Run evidence: \*\*unreadable\*\*/)
  assert.match(body, /No cases are claimed as passing/)
  assert.match(body, /no freeze or baseline is eligible/)
  assert.equal(fs.readFileSync(runFile, 'utf8'), '{incomplete-run')
  assert.equal(fs.readFileSync(payloadSummary, 'utf8'), 'preserved partial summary')
  assert.deepEqual(fs.readdirSync(selected.directory).sort(), before)
  assert.equal(evidence(selected).baseline, false)
})

test('a live writer with a temporarily passing run cannot contribute counts to the finalization summary', { skip: !posix, timeout: 15000 }, async t => {
  const selected = runningFixture(t, { hangCommand: 'package' })
  await until(() => readable(path.join(selected.directory, 'stage-ready.json')))
  const runFile = path.join(selected.directory, 'run/run.json')
  fs.mkdirSync(path.dirname(runFile))
  const record = JSON.stringify({ version: 1, status: 'passed', selectedCount: 7, summary: { passed: 7 } })
  fs.writeFileSync(runFile, record)
  const summary = path.join(selected.root, 'job-summary.md')
  const result = spawnSync(process.execPath, [finalizer], { cwd: selected.root, encoding: 'utf8', env: { ...selected.environment(), GITHUB_STEP_SUMMARY: summary } })
  assert.equal(result.status, 1)
  const body = fs.readFileSync(summary, 'utf8')
  assert.match(body, /Evidence finality: \*\*unconfirmed\*\*/)
  assert.match(body, /No cases are claimed as passing/)
  assert.doesNotMatch(body, /Result: \*\*passed\*\*|\| passed \| 7 \|/)
  assert.equal(fs.readFileSync(runFile, 'utf8'), record)
  assert.equal(fs.existsSync(path.join(selected.directory, 'summary.md')), false)
  assert.equal(fs.existsSync(path.join(selected.directory, 'evidence-freeze.json')), false)
  assert.equal(evidence(selected).baseline, false)
  process.kill(read(path.join(selected.directory, 'stage-ready.json')).pid, 0)
})
