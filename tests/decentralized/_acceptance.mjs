import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { redact } from '../../scripts/acceptance/lib/process.mjs'

export const clusterDetached = (environment = process.env) => environment.HALO_ACCEPTANCE_CLUSTER_RUN !== '1'
export const isMain = url => Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === url

export function declareClusterCases(suite, url, rows) {
  const filename = fileURLToPath(url)
  const root = path.resolve(path.dirname(filename), '../..')
  const source = fs.readFileSync(filename, 'utf8')
  const cases = rows.map(({ nativeId, caseId, title, mode = 'none', requires = [], nodes = 3 }) => ({
    id: `cluster:${suite}:${nativeId}`, title, titlePath: [suite, title],
    file: path.relative(root, filename).split(path.sep).join('/'),
    line: source.slice(0, source.indexOf(`'${caseId}'`)).split('\n').length,
    project: `cluster:${suite}`, executor: 'cluster', expectedStatus: 'passed',
    bindings: [{ caseId, evidence: 'integration', mode, variant: {} }],
    cluster: { suite, nativeId, requires, nodes },
  }))
  if (new Set(cases.map(test => test.id)).size !== cases.length) throw new Error(`Duplicate cluster declaration in ${suite}`)
  return cases
}

export function requiredNativeIds(cases, selected) {
  const byId = new Map(cases.map(test => [test.cluster.nativeId, test]))
  const result = new Set()
  const visiting = new Set()
  function add(id) {
    if (result.has(id)) return
    const test = byId.get(id)
    if (!test) throw new Error(`Unknown cluster scenario: ${id}`)
    if (visiting.has(id)) throw new Error(`Cyclic cluster prerequisite: ${id}`)
    visiting.add(id)
    for (const dependency of test.cluster.requires) add(dependency)
    visiting.delete(id)
    result.add(id)
  }
  selected.forEach(add)
  return [...result]
}

export function checkedRunPath(root, filename) {
  let absolute = path.resolve(filename)
  let ancestor = absolute
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  absolute = path.join(fs.realpathSync(ancestor), path.relative(ancestor, absolute))
  const relative = path.relative(fs.realpathSync(root), absolute)
  if (!relative || absolute === path.parse(absolute).root) throw new Error('Cluster output must be a dedicated run directory')
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', relative], { cwd: root, stdio: 'ignore' })
    if (tracked.status === 0) throw new Error(`Cluster output is tracked, not ignored run data: ${relative}`)
    const check = spawnSync('git', ['check-ignore', '--quiet', '--no-index', relative], { cwd: root })
    if (check.status !== 0) throw new Error(`Cluster output is not ignored: ${relative}`)
  }
  return absolute
}

export function selectedClusterCases(cases, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('Select one or more unique cluster test IDs')
  return ids.map(id => {
    const test = cases.find(test => test.id === id)
    if (!test) throw new Error(`Unknown cluster test: ${id}`)
    return test
  })
}

export function startAcceptanceRun({ root, cases, selectionFile, eventFile, environment = process.env }) {
  if (!selectionFile && !eventFile) return null
  if (!selectionFile || !eventFile) throw new Error('Cluster acceptance requires both a selection file and an event file')
  const expected = JSON.parse(fs.readFileSync(selectionFile, 'utf8'))
  const tests = selectedClusterCases(cases, expected.map(test => test.id))
  for (let index = 0; index < tests.length; index++) {
    if (!isDeepStrictEqual(tests[index], expected[index])) throw new Error(`Cluster declaration changed after selection: ${tests[index].id}`)
  }
  const modes = new Set(tests.map(test => test.bindings[0].mode))
  if (environment.HALO_ACCEPTANCE_CLUSTER_RUN !== '1' || modes.size !== 1) throw new Error('Cluster acceptance requires an owned process group and one model mode')
  const mode = tests[0].bindings[0].mode
  if (mode === 'live' && environment.HALO_ACCEPTANCE_MODE !== 'brokered-live') throw new Error('Live cluster scenarios require the acceptance budget broker')
  if (mode === 'none' && (environment.HALO_TEST_API_KEY || environment.HALO_TEST_MODEL_API_KEY || environment.HALO_TEST_SIGNED_IN_SOURCE || environment.HALO_TEST_OAUTH_SOURCE)) throw new Error('Protocol-only cluster scenarios must not receive a model credential or signed-in source')
  const output = checkedRunPath(root, eventFile)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const startedAt = new Date().toISOString()
  const clean = value => typeof value === 'string' ? redact(value, root) : Array.isArray(value) ? value.map(clean)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value
  const emit = event => fs.appendFileSync(output, JSON.stringify(clean(event)) + '\n')
  emit({ type: 'begin', tests, workers: 1, executor: 'cluster' })
  return {
    tests,
    nativeIds: requiredNativeIds(cases, tests.map(test => test.cluster.nativeId)),
    finish(records, failure) {
      let failed = false
      const finishedAt = new Date().toISOString()
      if (failure) { failed = true; emit({ type: 'error', message: failure.stack ?? failure.message ?? String(failure) }) }
      for (const test of tests) {
        const ids = requiredNativeIds(cases, [test.cluster.nativeId])
        const checks = records.filter(record => ids.includes(record.id))
        if (ids.some(id => !checks.some(record => record.id === id))) {
          failed = true
          emit({ type: 'error', message: `Cluster scenario did not produce every required result: ${test.id}` })
          continue
        }
        const status = checks.some(record => ['FAIL', 'PARTIAL'].includes(record.status)) ? 'failed'
          : checks.some(record => record.status === 'SKIP') ? 'skipped' : checks.every(record => record.status === 'PASS') ? 'passed' : 'failed'
        failed ||= status !== 'passed'
        emit({ type: 'test', id: test.id, title: test.title, bindings: test.bindings, expectedStatus: test.expectedStatus,
          status, retry: 0, startedAt, finishedAt, timingScope: 'shared-cluster-fixture',
          isolation: [mode === 'live' ? 'brokered-cluster-profile' : 'fresh-cluster-profile'],
          errors: status === 'passed' ? [] : checks.filter(record => record.status !== 'PASS').map(record => `${record.id} ${record.status}: ${record.evidence}`),
          attachments: [], checks: checks.map(record => ({ id: record.id, status: record.status, evidence: record.evidence })),
        })
      }
      emit({ type: 'end', status: failed ? 'failed' : 'passed', duration: Date.now() - Date.parse(startedAt), executor: 'cluster' })
      if (failed) process.exitCode = 1
    },
  }
}
