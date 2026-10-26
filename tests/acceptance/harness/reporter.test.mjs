import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const reporterPath = path.join(root, 'scripts/acceptance/playwright-reporter.ts')

test('reporter errors, metadata and owned text attachments are all redacted', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-reporter-redaction-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'events.jsonl')
  const previousReport = process.env.HALO_ACCEPTANCE_REPORT
  const previousToken = process.env.REVIEW_SYNTHETIC_TOKEN
  const secret = 'synthetic-reporter-token-value'
  context.after(() => {
    if (previousReport === undefined) delete process.env.HALO_ACCEPTANCE_REPORT; else process.env.HALO_ACCEPTANCE_REPORT = previousReport
    if (previousToken === undefined) delete process.env.REVIEW_SYNTHETIC_TOKEN; else process.env.REVIEW_SYNTHETIC_TOKEN = previousToken
  })
  process.env.HALO_ACCEPTANCE_REPORT = output
  process.env.REVIEW_SYNTHETIC_TOKEN = secret
  const compiled = await build({ entryPoints: [reporterPath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  const { default: Reporter } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
  const reporter = new Reporter()
  reporter.onError({ message: `Setup failed: ${secret}` })
  const attachment = path.join(directory, 'main.log')
  await fs.writeFile(attachment, `API rejected ${secret}\nAuthorization: Bearer standalone-secret\n`)
  const fakeTest = { id: 'test-id', title: `title ${secret}`, annotations: [], expectedStatus: 'passed' }
  reporter.onTestEnd(fakeTest, { status: 'passed', retry: 0, duration: 1, startTime: new Date(), errors: [{ message: `error ${secret}` }], attachments: [{ name: `log ${secret}`, contentType: 'text/plain', path: attachment }] })
  const events = await fs.readFile(output, 'utf8')
  assert.equal(events.includes(secret), false)
  assert.equal(events.includes(directory), false)
  assert.doesNotMatch(await fs.readFile(attachment, 'utf8'), /synthetic-reporter-token-value|standalone-secret/)
  const record = events.trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'test')
  assert.equal(record.attachments[0].path, 'main.log')
  const large = path.join(directory, 'large.log')
  await fs.writeFile(large, secret + 'x'.repeat(16 * 1024 * 1024))
  reporter.onTestEnd(fakeTest, { status: 'passed', retry: 0, duration: 1, startTime: new Date(), errors: [], attachments: [{ name: 'large', contentType: 'text/plain', path: large }] })
  assert.doesNotMatch(await fs.readFile(large, 'utf8'), /synthetic-reporter-token-value/)
  assert.match(await fs.readFile(output, 'utf8'), /exceeds the redaction limit/)
})

test('an annotation mismatch stops Playwright before the unplanned test executes', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-selection-guard-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}')
  const config = path.join(directory, 'playwright.config.mjs')
  await fs.writeFile(config, 'export default {testDir:".",testMatch:"probe.spec.js",workers:1};')
  const spec = caseId => `import {test} from '@playwright/test';import fs from 'node:fs';test('stable title',{annotation:{type:'acceptance',description:JSON.stringify({caseId:'${caseId}',evidence:'app-e2e',mode:'none',variant:{}})}},()=>{fs.writeFileSync('unexpected-ran','yes')});`
  await fs.writeFile(path.join(directory, 'probe.spec.js'), spec('case.a'))
  const events = path.join(directory, 'events.jsonl')
  const environment = { ...process.env, HALO_ACCEPTANCE_ROOT: directory, HALO_ACCEPTANCE_REPORT: events }
  delete environment.HALO_ACCEPTANCE_SELECTION
  delete environment.HALO_ACCEPTANCE_TEST_IDS
  const args = [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', config, '--reporter', reporterPath, '--output', path.join(directory, 'results')]
  const discovery = spawnSync(process.execPath, [...args, '--list'], { cwd: directory, encoding: 'utf8', timeout: 20000, env: environment })
  assert.equal(discovery.status, 0, discovery.stdout + discovery.stderr)
  const begin = (await fs.readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'begin')
  await fs.writeFile(path.join(directory, 'probe.spec.js'), spec('case.b'))
  await fs.unlink(events)
  const execution = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 20000, env: { ...environment, HALO_ACCEPTANCE_SELECTION: JSON.stringify(begin.tests) } })
  assert.equal(execution.status, 1, execution.stdout + execution.stderr)
  assert.equal(await fs.access(path.join(directory, 'unexpected-ran')).then(() => true, () => false), false)
  assert.match(await fs.readFile(events, 'utf8'), /does not match the selected test plan/)
})
