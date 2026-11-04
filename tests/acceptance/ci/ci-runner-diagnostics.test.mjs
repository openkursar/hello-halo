import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { parse } from 'yaml'

const workflow = parse(fs.readFileSync(new URL('./runner-diagnostics.yml', import.meta.url), 'utf8'))
const acceptance = parse(fs.readFileSync(new URL('./acceptance.yml', import.meta.url), 'utf8'))
const job = workflow.jobs.processes
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const script = job.steps[0].run
const supported = process.platform === 'darwin'
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

test('the diagnostics workflow is manual, read-only by default, secretless and runs where acceptance runs', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.equal(workflow.on.workflow_dispatch.inputs.cleanup.default, false)
  assert.equal(workflow.on.workflow_dispatch.inputs.cleanup.type, 'boolean')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(job['runs-on'], acceptance.jobs.acceptance['runs-on'])
  assert.equal(job.env.HALO_CLEANUP, '${{ inputs.cleanup }}')
  assert.equal(job.steps.length, 1)
  assert.equal(/secrets\.|\.ssh|\.claude|\$HOME|~\//.test(JSON.stringify(workflow)), false)
  assert.equal(JSON.stringify(job).includes('github.token'), false)
})

// Each fixture process is started detached through a subshell so that launchd adopts it.
async function fixture(context) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-diagnostics-')))
  const started = []
  context.after(() => { for (const pid of started) { try { process.kill(pid, 'SIGKILL') } catch {} } fs.rmSync(root, { recursive: true, force: true }) })
  const work = path.join(root, '_work')
  const temp = path.join(work, '_temp')
  fs.mkdirSync(temp, { recursive: true })
  fs.mkdirSync(path.join(root, 'tmp'))
  const launch = (directory, name, { orphan = true, ignoreTerm = false } = {}) => {
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, name)
    fs.writeFileSync(file, `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}require('node:fs').writeFileSync(${JSON.stringify(file + '.pid')}, String(process.pid)); setInterval(() => {}, 1000)`)
    if (orphan) spawnSync('bash', ['-c', `( ${JSON.stringify(process.execPath)} ${JSON.stringify(file)} >/dev/null 2>&1 & )`])
    else { const child = spawn(process.execPath, [file], { stdio: 'ignore' }); started.push(child.pid); child.unref() }
    return file + '.pid'
  }
  const pidOf = async file => {
    for (let attempt = 0; attempt < 100; attempt++) { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8')) { const pid = Number(fs.readFileSync(file, 'utf8')); started.push(pid); return pid } await wait(50) }
    throw new Error('fixture process did not start')
  }
  const run = (overrides = {}) => {
    const summary = path.join(root, 'summary.md')
    fs.rmSync(summary, { force: true })
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: temp, TMPDIR: path.join(root, 'tmp') + '/', GITHUB_STEP_SUMMARY: summary, HALO_CLEANUP: 'false', HALO_MINIMUM_AGE_SECONDS: '1', HALO_TERM_GRACE_SECONDS: '1', ...overrides }, timeout: 60000 })
    return { ...result, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' }
  }
  return { root, work, launch, pidOf, run }
}

test('a read-only run reports orphans and stops nothing', { skip: !supported }, async context => {
  const selected = await fixture(context)
  const pid = await selected.pidOf(selected.launch(path.join(selected.work, 'repo/repo/halo/node_modules/playwright'), 'idle.js'))
  await wait(1500)
  const result = selected.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.summary, /Load average/)
  assert.match(result.summary, new RegExp(`${pid} 1 \\d+m playwright ci`))
  assert.match(result.summary, /Read-only run: nothing was stopped/)
  assert.equal(alive(pid), true)
})

test('cleanup stops only an old orphan inside the CI directories, asks first and forces what ignores the request', { skip: !supported }, async context => {
  const selected = await fixture(context)
  const gentle = await selected.pidOf(selected.launch(path.join(selected.work, 'repo/repo/halo/node_modules/electron'), 'gentle.js'))
  const stubborn = await selected.pidOf(selected.launch(path.join(selected.work, 'repo/repo/halo/out/main'), 'stubborn.js', { ignoreTerm: true }))
  const temporary = await selected.pidOf(selected.launch(path.join(selected.root, 'tmp/halo-acceptance-profile'), 'profile.js'))
  const elsewhere = await selected.pidOf(selected.launch(path.join(selected.root, 'owner-project'), 'elsewhere.js'))
  const supervised = await selected.pidOf(selected.launch(path.join(selected.work, 'repo/repo/halo/node_modules/playwright'), 'supervised.js', { orphan: false }))
  await wait(2000)
  const result = selected.run({ HALO_CLEANUP: 'true' })
  assert.equal(result.status, 0, result.stderr)
  await wait(300)
  assert.equal(alive(gentle), false)
  assert.equal(alive(stubborn), false)
  assert.equal(alive(temporary), false)
  assert.equal(alive(elsewhere), true, 'an orphan outside the CI directories must be left alone')
  assert.equal(alive(supervised), true, 'a process that still has a parent must be left alone')
  assert.match(result.summary, new RegExp(`\\| ${gentle} \\| node \\| stopped by SIGTERM`))
  assert.match(result.summary, new RegExp(`\\| ${stubborn} \\| node \\| stopped by SIGKILL`))
  assert.match(result.summary, new RegExp(`\\| ${temporary} \\| node \\| stopped by SIGTERM`))
  assert.doesNotMatch(result.summary, new RegExp(`\\| ${elsewhere} \\|`))
})

test('a young orphan survives, and so does anything when the minimum age is not met', { skip: !supported }, async context => {
  const selected = await fixture(context)
  const pid = await selected.pidOf(selected.launch(path.join(selected.work, 'repo/repo/halo/node_modules/electron'), 'young.js'))
  const result = selected.run({ HALO_CLEANUP: 'true', HALO_MINIMUM_AGE_SECONDS: '600' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.summary, /No process met all conditions/)
  assert.equal(alive(pid), true)
})

test('the job refuses an unexpected runner layout and malformed numbers before touching anything', { skip: !supported }, async context => {
  const selected = await fixture(context)
  const pid = await selected.pidOf(selected.launch(path.join(selected.work, 'repo/repo/halo/node_modules/electron'), 'guard.js'))
  await wait(1500)
  for (const overrides of [{ RUNNER_TEMP: '/tmp' }, { RUNNER_TEMP: path.join(selected.root, 'elsewhere') }, { HALO_MINIMUM_AGE_SECONDS: 'x' }, { HALO_TERM_GRACE_SECONDS: '-1' }]) {
    const result = selected.run({ HALO_CLEANUP: 'true', ...overrides })
    assert.equal(result.status, 1, JSON.stringify(overrides))
    assert.equal(alive(pid), true)
  }
})

test('nothing is listed unless the controller repository is private, by the same rule as the acceptance workflow', async () => {
  const guard = workflow.jobs.controller.steps[0]
  assert.equal(job.needs, 'controller')
  assert.equal(guard.with.script.split('\n').slice(0, 3).join('\n'), acceptance.jobs.controller.steps[0].with.script.split('\n').slice(0, 3).join('\n'))
  assert.equal(workflow.jobs.controller['runs-on'], 'ubuntu-latest')
  const verify = new AsyncFunction('github', 'context', guard.with.script)
  const context = { repo: { owner: 'example', repo: 'controller' } }
  await verify({ rest: { repos: { get: async () => ({ data: { private: true, visibility: 'private' } }) } } }, context)
  for (const data of [{ private: false, visibility: 'public' }, { private: true, visibility: 'internal' }, {}]) {
    await assert.rejects(verify({ rest: { repos: { get: async () => ({ data }) } } }, context), /requires a private controller repository/)
  }
  await assert.rejects(verify({ rest: { repos: { get: async () => { throw Object.assign(new Error('x'), { status: 403 }) } } } }, context), /Could not verify controller repository visibility \(HTTP 403\)/)
})

test('cleanup leaves alone a pid that changed its command, runner services, the job\'s own ancestors and unrelated directories that merely contain halo-', { skip: !supported }, async context => {
  const selected = await fixture(context)
  const swap = path.join(selected.work, 'repo/repo/halo/node_modules/playwright/swap.sh')
  fs.mkdirSync(path.dirname(swap), { recursive: true })
  fs.writeFileSync(swap, `#!/bin/bash\ntrap 'exec sleep 300' TERM\necho $$ > ${JSON.stringify(swap + '.pid')}\nwhile :; do sleep 0.2; done\n`, { mode: 0o755 })
  spawnSync('bash', ['-c', `( bash ${JSON.stringify(swap)} >/dev/null 2>&1 & )`])
  const swapped = await selected.pidOf(swap + '.pid')
  const service = await selected.pidOf(selected.launch(path.join(selected.work, 'repo/repo'), 'RunnerService.js'))
  const lookalike = await selected.pidOf(selected.launch(path.join(selected.root, 'halo-project'), 'lookalike.js'))
  const scriptFile = path.join(selected.root, 'diagnostics.sh')
  fs.writeFileSync(scriptFile, script)
  const wrapperDirectory = path.join(selected.work, 'repo/repo/halo/node_modules/playwright')
  const wrapperFile = path.join(wrapperDirectory, 'wrapper.js')
  const summary = path.join(selected.root, 'wrapper-summary.md')
  fs.writeFileSync(wrapperFile, `const r = require('node:child_process').spawnSync('bash', [${JSON.stringify(scriptFile)}], { env: { PATH: process.env.PATH, RUNNER_TEMP: ${JSON.stringify(path.join(selected.work, '_temp'))}, TMPDIR: ${JSON.stringify(path.join(selected.root, 'tmp') + '/')}, GITHUB_STEP_SUMMARY: ${JSON.stringify(summary)}, HALO_CLEANUP: 'true', HALO_MINIMUM_AGE_SECONDS: '1', HALO_TERM_GRACE_SECONDS: '2' }, encoding: 'utf8' }); require('node:fs').writeFileSync(${JSON.stringify(wrapperFile + '.done')}, String(r.status) + r.stderr)\nrequire('node:fs').writeFileSync(${JSON.stringify(wrapperFile + '.pid')}, String(process.pid))`)
  await wait(1500)
  spawnSync('bash', ['-c', `( ${JSON.stringify(process.execPath)} ${JSON.stringify(wrapperFile)} >/dev/null 2>&1 & )`])
  for (let attempt = 0; attempt < 200 && !fs.existsSync(wrapperFile + '.done'); attempt++) await wait(100)
  assert(fs.existsSync(wrapperFile + '.done'), 'the wrapped run finished')
  assert.match(fs.readFileSync(wrapperFile + '.done', 'utf8'), /^0/)
  assert.equal(alive(swapped), true, 'a pid whose command changed after SIGTERM must not be killed')
  assert.equal(alive(service), true, 'the runner service must not be stopped')
  assert.equal(alive(lookalike), true, 'a directory that merely contains halo- is not a CI directory')
  const report = fs.readFileSync(summary, 'utf8')
  assert.match(report, new RegExp(`\\| ${swapped} \\| playwright \\| pid reused by another command; left alone`))
  assert.doesNotMatch(report, new RegExp(`\\| ${service} \\|`))
  // The wrapper is an old CI-directory orphan and an ancestor of the script: it is a candidate by every rule but that one.
  assert.doesNotMatch(report, /wrapper\.js/)
  assert.match(fs.readFileSync(wrapperFile + '.pid', 'utf8'), /^\d+$/)
})
