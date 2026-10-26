import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execute, redact } from '../../../scripts/acceptance/lib/process.mjs'

test('captured output and persisted logs redact credentials supplied only to the child', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-process-log-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const secret = 'synthetic-child-secret-for-test'
  const logfile = path.join(directory, 'runner.log')
  const result = await execute(directory, ['-e', 'console.log(process.env.PROVIDER_API_KEY);console.error("Authorization: Bearer another-sensitive-value")'], { environment: { PROVIDER_API_KEY: secret }, logFile: logfile })
  assert.equal(result.code, 0)
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
  assert.equal(result.cleanupFailed, false)
  let alive = true
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(descendantPid, 0) } catch (error) { if (error.code === 'ESRCH') { alive = false; break } throw error }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(alive, false, 'the owned descendant must not keep running after execute resolves')
})
