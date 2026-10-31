import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { execute, redact, terminateOwnedProcessTree } from '../../../scripts/acceptance/lib/process.mjs'

for (const persistent of [false, true]) test(`${persistent ? 'persistent' : 'transient'} exit-probe EPERM requires an actual absence observation`, { skip: process.platform === 'win32', timeout: 10000 }, async context => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  const closed = once(child, 'close')
  await once(child, 'spawn')
  const kill = process.kill
  let signalled = false, denied = 0
  process.kill = function (pid, signal) {
    if (pid === -child.pid) {
      if (signal === 0 && signalled && (persistent || denied < 2)) {
        denied++
        throw Object.assign(new Error('Synthetic owned exit-probe denial'), { code: 'EPERM' })
      }
      if (signal === 'SIGTERM') signalled = true
    }
    return kill.call(process, pid, signal)
  }
  context.after(async () => {
    process.kill = kill
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  const messages = []
  const result = await terminateOwnedProcessTree(child.pid, message => messages.push(message))
  assert.equal(result, !persistent)
  assert(denied >= 2)
  assert.equal(messages.filter(message => message.includes('returned EPERM')).length, 1)
  await closed
  assert.throws(() => kill.call(process, child.pid, 0), { code: 'ESRCH' })
  if (persistent) assert(messages.some(message => message.includes('cleanup is unconfirmed')))
})

test('captured output and persisted logs redact credentials supplied only to the child', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-process-log-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const secret = 'synthetic-child-secret-for-test'
  const logfile = path.join(directory, 'runner.log')
  const result = await execute(directory, ['-e', 'console.log(process.env.PROVIDER_API_KEY);console.error("Authorization: Bearer another-sensitive-value")'], { environment: { PROVIDER_API_KEY: secret }, logFile: logfile })
  assert.equal(result.code, 0)
  assert.equal(result.processExitCode, 0)
  assert.equal(result.cleanupFailed, false)
  assert.doesNotMatch(result.log, /synthetic-child-secret|another-sensitive-value/)
  assert.equal(await fs.readFile(logfile, 'utf8'), result.log)
  assert.match(result.log, /REDACTED/)
})

test('redaction removes nested secrets and local account paths without hiding ordinary diagnostics', () => {
  const result = redact('long-secret-token /workspace/main.ts /private-user/file api_key="literal-sensitive-key" response status 429', '/workspace', { API_TOKEN: 'long-secret-token', HOME: '/private-user' })
  assert.doesNotMatch(result, /long-secret-token|literal-sensitive-key|\/private-user|\/workspace/)
  assert.match(result, /response status 429/)
})

test('timeout kills an owned descendant after its group leader has already exited', { skip: process.platform === 'win32' }, async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-owned-tree-'))
  let descendantPid
  context.after(async () => {
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch {} }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const marker = path.join(directory, 'descendant.pid')
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`
  const launcher = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`
  const result = await execute(directory, ['-e', launcher], { timeoutMs: 500 })
  descendantPid = Number(await fs.readFile(marker, 'utf8'))
  assert.equal(result.timedOut, true)
  assert.equal(result.processExitCode, null)
  assert.equal(result.cleanupFailed, false)
  let alive = true
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(descendantPid, 0) } catch (error) { if (error.code === 'ESRCH') { alive = false; break } throw error }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(alive, false, 'the owned descendant must not keep running after execute resolves')
})
