import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { discoverClusterTests, executeClusterTests, clusterEnvironment } from '../../scripts/acceptance/adapters/cluster.mjs'
import { clusterDetached, requiredNativeIds, startAcceptanceRun, checkedRunPath } from './_acceptance.mjs'
import { execute } from '../../scripts/acceptance/lib/process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('driver discovery lists real declarations without starting nodes', async () => {
  const cases = await discoverClusterTests(root)
  assert.equal(cases.length, 47)
  assert.equal(cases.filter(item => item.bindings[0].mode === 'live').length, 13)
  assert.ok(cases.every(item => item.executor === 'cluster' && item.bindings[0].evidence === 'integration'))
  for (const file of new Set(cases.map(item => item.file))) {
    const result = spawnSync(process.execPath, [file, '--list'], { cwd: root, encoding: 'utf8', timeout: 3000 })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), cases.filter(item => item.file === file))
    assert.doesNotMatch(result.stdout, /Starting \d+ node/)
  }
})

test('selection expands declared prerequisites and refuses unknown cases', async () => {
  const cases = await discoverClusterTests(root)
  const federation = cases.filter(item => item.cluster.suite === 'federation')
  assert.deepEqual(requiredNativeIds(federation, ['M2']), ['M1', 'M2'])
  assert.deepEqual(requiredNativeIds(federation, ['E3']), ['E1', 'E3'])
  assert.throws(() => requiredNativeIds(federation, ['does-not-exist']), /Unknown/)
  await assert.rejects(executeClusterTests(root, [{ ...cases[0], bindings: [] }], {}), /changed cluster selection/)
  assert.throws(() => checkedRunPath(root, path.join(root, 'tests/decentralized/RESULTS.md')), /not ignored/)
})

test('protocol mode prevents .env credentials and signed-in sources from entering nodes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-cluster-environment-'))
  try {
    await fs.writeFile(path.join(directory, '.env.local'), 'HALO_TEST_MODEL_API_KEY=must-not-load\nHALO_TEST_SIGNED_IN_SOURCE=must-not-load\nHALO_TEST_EXTRA_TOKEN=must-not-load\n')
    const environment = await clusterEnvironment(directory, 'none', { OPENAI_API_KEY: 'must-not-load', HALO_TEST_API_KEY: 'must-not-load' })
    for (const name of ['OPENAI_API_KEY', 'HALO_TEST_API_KEY', 'HALO_TEST_MODEL_API_KEY', 'HALO_TEST_SIGNED_IN_SOURCE', 'HALO_TEST_EXTRA_TOKEN']) assert.equal(environment[name], '')
    assert.equal(environment.HALO_TEST_API_URL, 'http://127.0.0.1:1')
    assert.equal(environment.HALO_TEST_SDK_ENGINE, 'halo')
    await assert.rejects(clusterEnvironment(directory, 'live', { HALO_TEST_API_URL: 'https://example.com', HALO_TEST_API_KEY: 'unbrokered' }), /budget broker/)
    const brokered = await clusterEnvironment(directory, 'live', { HALO_ACCEPTANCE_MODE: 'brokered-live', HALO_TEST_API_URL: 'http://127.0.0.1:9999', HALO_TEST_API_KEY: 'local-broker-client', HALO_TEST_MODEL: 'test-model', HALO_TEST_PROVIDER: 'anthropic' })
    assert.equal(brokered.HALO_TEST_API_KEY, 'local-broker-client')
    assert.equal(brokered.HALO_TEST_MODEL_API_KEY, '')
    assert.equal(brokered.HALO_TEST_API_TYPE, 'anthropic_passthrough')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('partial native results fail and missing prerequisite results never become passes', async () => {
  const cases = await discoverClusterTests(root)
  const selected = cases.find(item => item.cluster.nativeId === 'M2')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-cluster-events-'))
  const oldExitCode = process.exitCode
  try {
    const selectionFile = path.join(directory, 'selection.json')
    const eventFile = path.join(directory, 'events.jsonl')
    const environment = { HALO_ACCEPTANCE_CLUSTER_RUN: '1', HALO_ACCEPTANCE_MODE: 'deterministic' }
    await fs.writeFile(selectionFile, JSON.stringify([selected]))
    const run = startAcceptanceRun({ root, cases, selectionFile, eventFile, environment })
    run.finish([{ id: 'M1', status: 'PASS', evidence: 'created' }, { id: 'M2', status: 'PARTIAL', evidence: 'rename did not converge' }])
    const events = (await fs.readFile(eventFile, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(events.find(event => event.type === 'test').status, 'failed')
    assert.deepEqual(events.find(event => event.type === 'test').bindings, selected.bindings)
    const missing = path.join(directory, 'missing.jsonl')
    startAcceptanceRun({ root, cases, selectionFile, eventFile: missing, environment }).finish([{ id: 'M2', status: 'PASS', evidence: 'renamed' }])
    const incomplete = (await fs.readFile(missing, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(incomplete.filter(event => event.type === 'test').length, 0)
    assert.ok(incomplete.some(event => event.type === 'error'))
  } finally { process.exitCode = oldExitCode; await fs.rm(directory, { recursive: true, force: true }) }
})

test('acceptance descendants stay in the owned process group and are removed on timeout', { skip: process.platform === 'win32' }, async () => {
  assert.equal(clusterDetached({}), true)
  assert.equal(clusterDetached({ HALO_ACCEPTANCE_CLUSTER_RUN: '1' }), false)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-cluster-process-'))
  try {
    const pidFile = path.join(directory, 'descendant.pid')
    const fixture = path.join(directory, 'parent.mjs')
    await fs.writeFile(fixture, `import { spawn } from 'node:child_process'; import fs from 'node:fs'; import { clusterDetached } from ${JSON.stringify(new URL('./_acceptance.mjs', import.meta.url).href)}; const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: clusterDetached(), stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`)
    const result = await execute(root, [fixture], { environment: { HALO_ACCEPTANCE_CLUSTER_RUN: '1' }, timeoutMs: 1500 })
    assert.equal(result.timedOut, true)
    assert.equal(result.cleanupFailed, false)
    const pid = Number(await fs.readFile(pidFile, 'utf8'))
    const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
    assert.ok(status.status !== 0 || status.stdout.trim().startsWith('Z'), 'The owned descendant must no longer be running')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
