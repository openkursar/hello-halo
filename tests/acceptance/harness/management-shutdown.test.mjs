import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'management-shutdown-test-'))
after(() => fs.rm(directory, { recursive: true, force: true }))
const module = path.join(directory, 'management.mjs')
await build({ entryPoints: [fileURLToPath(new URL('../../e2e/fixtures/acceptance-management-process.ts', import.meta.url))], outfile: module, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { trackManagementApp, closeManagementApp, inspectManagementProcessGroup } = await import(pathToFileURL(module).href)

async function childProcess(context) {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("fixture-ready-output"); setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.resume()
  const closed = once(child, 'close')
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  await once(child.stdout, 'data')
  child.stdout.resume()
  return child
}

test('ordinary management closes retain the existing behavior without diagnostics or additional lifecycle listeners', async context => {
  const child = await childProcess(context)
  const exitListeners = child.listenerCount('exit')
  const owned = trackManagementApp({ process: () => child, close: async () => { child.kill('SIGTERM') } })
  assert.equal(owned.diagnostics, undefined)
  assert.equal(child.listenerCount('exit'), exitListeners)
  await closeManagementApp(owned)
  assert.equal(owned.closed, true)
  assert.equal(owned.diagnostics, undefined)
})

test('opt-in diagnostics distinguish the close request, child lifecycle and pipe completion without recording process arguments', async context => {
  const child = await childProcess(context)
  let closeCalls = 0
  const owned = trackManagementApp({ process: () => child, close: async () => { closeCalls++; child.kill('SIGTERM') } }, true)
  await closeManagementApp(owned, undefined, 'restart')
  const diagnostic = owned.diagnostics
  assert.equal(diagnostic.pid, child.pid)
  const attempt = diagnostic.attempts[0]
  assert.equal(attempt.phase, 'restart')
  assert.equal(attempt.timeoutMs, 15000)
  assert.equal(attempt.appClose, 'resolved')
  assert.equal(attempt.timedOut, false)
  assert.equal(attempt.afterClose.closeObserved, true)
  for (const event of ['close-requested', 'app-close-resolved', 'child-exit', 'child-close', 'stdout-end', 'stdout-close', 'stderr-end', 'stderr-close']) assert(diagnostic.events.some(entry => entry.event === event), event)
  await closeManagementApp(owned, undefined, 'teardown')
  assert.equal(closeCalls, 1)
  assert.equal(diagnostic.attempts[1].phase, 'teardown')
  assert.equal(diagnostic.attempts[1].alreadyClosed, true)
  assert.equal(diagnostic.attempts[1].appClose, 'not-called')
  assert.doesNotMatch(JSON.stringify(diagnostic), /setInterval|stdout\.write|process\.env|fixture-ready-output/)
})

test('a finished child cannot turn an unresolved Playwright close into a passing shutdown', async context => {
  const child = await childProcess(context)
  const owned = trackManagementApp({ process: () => child, close: () => { child.kill('SIGTERM'); return new Promise(() => {}) } }, true)
  await assert.rejects(closeManagementApp(owned, 500, 'restart'), /did not close within its deadline/)
  const attempt = owned.diagnostics.attempts[0]
  assert.equal(attempt.appClose, 'pending')
  assert.equal(attempt.timedOut, true)
  assert.equal(attempt.atTimeout.closeObserved, true)
  assert(attempt.atTimeout.exitCode !== null || attempt.atTimeout.signalCode !== null)
  if (process.platform !== 'win32') assert.equal(attempt.atTimeout.signalCode, 'SIGTERM')
  assert.equal(owned.diagnostics.events.some(event => event.event === 'forced-cleanup-requested'), false)
  assert.deepEqual(attempt.processGroup.processes, [])
})

test('a resolved Playwright close cannot hide a still-running child and forced cleanup still leaves the test failed', async context => {
  const child = await childProcess(context)
  const owned = trackManagementApp({ process: () => child, close: async () => {} }, true)
  await assert.rejects(closeManagementApp(owned, 100, 'teardown'), /did not close within its deadline/)
  const attempt = owned.diagnostics.attempts[0]
  assert.equal(attempt.appClose, 'resolved')
  assert.equal(attempt.timedOut, true)
  assert.equal(attempt.atTimeout.closeObserved, false)
  assert.equal(attempt.atTimeout.exitCode, null)
  assert.equal(attempt.atTimeout.signalCode, null)
  assert.equal(attempt.afterClose.closeObserved, true)
  assert(owned.diagnostics.events.some(event => event.event === 'forced-cleanup-requested'))
  assert.equal(attempt.processGroup.mayOverlapForcedCleanup, true)
  for (const entry of attempt.processGroup.processes) {
    assert.deepEqual(Object.keys(entry).sort(), ['comm', 'pid', 'ppid'])
    assert.equal(entry.pid, child.pid, 'the fixture owns only this ordinary Node child')
    assert.doesNotMatch(entry.comm, /setInterval|stdout\.write/)
  }
})

test('a rejected close retains its original failure and diagnostics omit arbitrary error payloads', async context => {
  const child = await childProcess(context)
  const failure = Object.assign(new Error('synthetic-private-credential must not enter diagnostics'), { code: 'ECONNRESET' })
  const owned = trackManagementApp({ process: () => child, close: async () => { throw failure } }, true)
  await assert.rejects(closeManagementApp(owned, 500, 'restart'), error => error === failure)
  assert.equal(owned.closed, true)
  assert.equal(owned.diagnostics.attempts[0].appClose, 'rejected')
  assert.equal(owned.diagnostics.attempts[0].timedOut, false)
  assert(owned.diagnostics.events.some(event => event.event === 'app-close-rejected' && event.errorCode === 'ECONNRESET'))
  assert.doesNotMatch(JSON.stringify(owned.diagnostics), /synthetic-private-credential/)
})


test('the bounded process snapshot contains only the owned group and no command arguments', async context => {
  const child = await childProcess(context)
  const result = await inspectManagementProcessGroup(child.pid)
  if (process.platform === 'win32') {
    assert.equal(result.errorCode, 'POSIX_GROUP_UNAVAILABLE')
    assert.deepEqual(result.processes, [])
    return
  }
  assert.equal(result.errorCode, undefined)
  assert.equal(result.processes.length, 1)
  assert.equal(result.processes[0].pid, child.pid)
  assert.equal(result.processes[0].ppid, process.pid)
  assert.deepEqual(Object.keys(result.processes[0]).sort(), ['comm', 'pid', 'ppid'])
  assert.doesNotMatch(result.processes[0].comm, /fixture-ready-output|setInterval/)
})

test('diagnostics retain the registered child after the Playwright application facade is disposed', async context => {
  const child = await childProcess(context)
  let disposed = false
  let processReads = 0
  const application = {
    process() {
      processReads++
      if (disposed) throw new TypeError("Cannot read properties of undefined (reading '_object')")
      return child
    },
    async close() {
      const completion = once(child, 'close')
      child.kill('SIGTERM')
      await completion
      disposed = true
    },
  }
  const owned = trackManagementApp(application, true)
  await closeManagementApp(owned, undefined, 'restart')
  await closeManagementApp(owned, undefined, 'teardown')
  assert.equal(processReads, 1, 'the public facade may no longer expose its implementation after disposal')
  assert.equal(owned.diagnostics.attempts[0].afterClose.closeObserved, true)
  assert.equal(owned.diagnostics.attempts[1].alreadyClosed, true)
})
