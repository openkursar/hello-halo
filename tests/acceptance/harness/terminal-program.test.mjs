import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const directory = await mkdtemp(path.join(tmpdir(), 'acceptance-terminal-program-'))
after(() => rm(directory, { recursive: true, force: true }))
const compiled = path.join(directory, 'program.cjs')
await build({ entryPoints: [fileURLToPath(new URL('../../e2e/fixtures/acceptance-pty-program.ts', import.meta.url))], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const { ownedPtyProgram, observeProcess } = createRequire(import.meta.url)(compiled)

async function until(check) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Owned fixture state did not settle')
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

test('the harmless fixture records actual cwd, process identity and ordered input and authenticates its cleanup endpoint', async () => {
  const cwd = path.join(directory, 'working files')
  await mkdir(cwd)
  const actualCwd = await realpath(cwd)
  const program = ownedPtyProgram(directory, 'interactive')
  program.bind('owned-terminal')
  const child = spawn(process.execPath, [program.file], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  program.markIssued()
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = once(child, 'exit')
  try {
    await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned fixture exited before its receipt: ${errors}`)
      return program.receipt()
    })
    assert.equal(program.receipt().pid, child.pid)
    assert.equal(program.receipt().cwd, actualCwd)
    assert.equal(program.receipt().shellPid, process.pid)
    assert.equal(observeProcess(child.pid).state, 'running')
    const refused = await fetch(`http://127.0.0.1:${program.receipt().port}/stop`, { method: 'POST' })
    assert.equal(refused.status, 403)
    assert.equal(observeProcess(child.pid).state, 'running')
    child.stdin.write('AI_marker\nUSER_marker\n')
    await until(() => program.inputs().length === 2)
    assert.deepEqual(program.inputs().map(value => [value.sequence, value.input, value.pid, value.cwd]), [[1, 'AI_marker', child.pid, actualCwd], [2, 'USER_marker', child.pid, actualCwd]])
    await until(() => output.includes(program.ack(2, 'USER_marker')))
    assert.ok(output.includes(program.ready))
    assert.ok(output.indexOf(program.ack(1, 'AI_marker')) < output.indexOf(program.ack(2, 'USER_marker')))
    await program.stopProgram()
    await exited
    assert.equal(errors, '')
    assert.equal(observeProcess(child.pid).state, 'exited')
    assert.equal(program.observation().exit.reason, 'fixture-cleanup')
    // This test owns a plain Node child, so its still-live parent must prevent a claim that a PTY shell exited.
    assert.equal(program.confirmedExited(), false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
  }
})

test('only ESRCH establishes an OS exit; permission or unclassified probe failures stay unknown', () => {
  assert.deepEqual(observeProcess(123, () => {}), { state: 'running' })
  assert.deepEqual(observeProcess(123, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }), { state: 'exited' })
  assert.deepEqual(observeProcess(123, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }), { state: 'unknown', code: 'EPERM' })
  assert.deepEqual(observeProcess(123, () => { throw new Error('unclassified') }), { state: 'unknown', code: 'UNAVAILABLE' })
  assert.deepEqual(observeProcess(0), { state: 'unknown', code: 'INVALID_PID' })
})

test('an issued program with absent or malformed receipts cannot authorize profile deletion', async () => {
  const program = ownedPtyProgram(directory, 'unconfirmed')
  program.bind('owned-terminal')
  program.markIssued()
  assert.equal(program.confirmedExited(), false)
  assert.equal(program.observation().process.code, 'RECEIPT_MISSING')
  await writeFile(path.join(path.dirname(program.file), 'process.json'), '{}')
  assert.equal(program.confirmedExited(), false)
  assert.equal(program.observation().process.code, 'RECEIPT_INVALID')
  await assert.rejects(program.stopProgram(), /owned program/)
  assert.throws(() => ownedPtyProgram(directory, '../escape'), /file-safe/)
})
