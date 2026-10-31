import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { execute, redact } from '../lib/process.mjs'
import { checkedRunPath, requiredNativeIds } from '../../../tests/decentralized/_acceptance.mjs'

const drivers = ['tests/decentralized/run-scenarios.mjs', 'tests/decentralized/checklist-single-machine.mjs']

export async function discoverClusterTests(root) {
  const tests = []
  for (const driver of drivers) {
    const module = await import(pathToFileURL(path.join(root, driver)).href)
    if (!Array.isArray(module.acceptanceCases)) throw new Error(`Cluster driver has no executable declarations: ${driver}`)
    tests.push(...module.acceptanceCases)
  }
  if (new Set(tests.map(test => test.id)).size !== tests.length) throw new Error('Duplicate cluster test identity')
  return tests
}

export async function clusterEnvironment(root, mode, environment = {}) {
  const result = { ...process.env, ...environment }
  const names = new Set(Object.keys(result))
  const local = await fs.readFile(path.join(root, '.env.local'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  for (const line of local.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (match) names.add(match[1])
  }
  for (const name of ['HALO_TEST_API_KEY', 'HALO_TEST_API_URL', 'HALO_TEST_MODEL', 'HALO_TEST_PROVIDER', 'HALO_TEST_MODEL_API_KEY', 'HALO_TEST_MODEL_BASE_URL', 'HALO_TEST_MODEL_ID', 'HALO_TEST_MODEL_PROVIDER', 'HALO_TEST_SIGNED_IN_SOURCE', 'HALO_TEST_OAUTH_SOURCE', 'HALO_TEST_FEDERATION_GATEWAY', 'HALO_TEST_API_TYPE', 'HALO_TEST_SDK_ENGINE', 'SDK_TEST_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY']) names.add(name)
  for (const name of names) if (name.startsWith('HALO_TEST_') || /^(?:SDK_TEST|OPENAI|ANTHROPIC|CLAUDE_CODE|CODEX|DEEPSEEK|OPENROUTER).*(?:KEY|TOKEN)/.test(name)) result[name] = ''
  Object.assign(result, { HALO_ACCEPTANCE_CLUSTER_RUN: '1', HALO_TEST_API_URL: 'http://127.0.0.1:1', HALO_TEST_MODEL: 'acceptance-protocol-only', HALO_TEST_PROVIDER: 'openai', HALO_TEST_SDK_ENGINE: 'halo', HALO_TEST_NO_PROXY: '1' })
  if (mode === 'live') {
    const url = new URL(environment.HALO_TEST_API_URL ?? 'about:blank')
    if (environment.HALO_ACCEPTANCE_MODE !== 'brokered-live' || url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || !environment.HALO_TEST_API_KEY || !environment.HALO_TEST_MODEL || !['openai', 'anthropic'].includes(environment.HALO_TEST_PROVIDER)) throw new Error('Live cluster execution requires an explicit local acceptance budget broker')
    Object.assign(result, { HALO_ACCEPTANCE_MODE: 'brokered-live', HALO_TEST_API_URL: url.href, HALO_TEST_API_KEY: environment.HALO_TEST_API_KEY,
      HALO_TEST_MODEL: environment.HALO_TEST_MODEL, HALO_TEST_PROVIDER: environment.HALO_TEST_PROVIDER,
      HALO_TEST_API_TYPE: environment.HALO_TEST_PROVIDER === 'anthropic' ? 'anthropic_passthrough' : 'chat_completions' })
  } else if (mode === 'none') {
    Object.assign(result, { HALO_ACCEPTANCE_MODE: 'deterministic', HALO_TEST_API_TYPE: 'chat_completions' })
  } else throw new Error(`Unsupported cluster model mode: ${mode}`)
  return result
}

export async function executeClusterTests(root, tests, { outputDirectory, eventFile, environment = {}, timeoutMs = 1800000 } = {}) {
  const available = await discoverClusterTests(root)
  if (!Array.isArray(tests) || !tests.length || new Set(tests.map(test => test.id)).size !== tests.length) throw new Error('Cluster execution requires a nonempty unique selection')
  for (const test of tests) {
    const declared = available.find(candidate => candidate.id === test.id)
    if (!declared || !isDeepStrictEqual(declared, test)) throw new Error(`Unknown or changed cluster selection: ${test.id}`)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Cluster execution requires a positive time budget')
  const directory = checkedRunPath(root, outputDirectory)
  const events = checkedRunPath(root, eventFile)
  const relative = path.relative(directory, events)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Cluster events must be inside the owned run directory')
  await fs.mkdir(directory, { recursive: true })
  const deadline = Date.now() + timeoutMs
  const groups = new Map()
  for (const test of tests) {
    const key = `${test.cluster.suite}-${test.bindings[0].mode}-${test.cluster.nodes}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(test)
  }
  const executions = []
  for (const [key, group] of groups) {
    if (Date.now() >= deadline) { executions.push({ code: 1, timedOut: true, log: 'Cluster time budget exhausted before the next selected group' }); break }
    const cases = available.filter(test => test.file === group[0].file)
    const nativeIds = requiredNativeIds(cases, group.map(test => test.cluster.nativeId))
    const dependencies = cases.filter(test => nativeIds.includes(test.cluster.nativeId))
    const mode = group[0].bindings[0].mode
    if (mode === 'none' && dependencies.some(test => test.bindings[0].mode !== 'none')) throw new Error('A protocol-only selection cannot execute a model-dependent prerequisite')
    const childEnvironment = await clusterEnvironment(root, mode, environment)
    const runDirectory = path.join(directory, 'cluster', key)
    await fs.mkdir(runDirectory, { recursive: true })
    const selection = path.join(runDirectory, 'selection.json')
    await fs.writeFile(selection, JSON.stringify(group, null, 2), { flag: 'wx' })
    const profiles = path.join(runDirectory, 'profiles')
    const results = path.join(runDirectory, 'native-results.md')
    const nodes = Math.max(...dependencies.map(test => test.cluster.nodes))
    if (dependencies.some(test => test.cluster.nodes !== nodes)) throw new Error('Cluster prerequisites must preserve the declared node topology')
    const args = [group[0].file, '--only', nativeIds.join(','), '--cluster', profiles, '--acceptance-selection', selection, '--acceptance-events', events, '--results', results, '--nodes', String(nodes)]
    let execution
    try {
      execution = await execute(root, args, { environment: childEnvironment, timeoutMs: Math.max(1, deadline - Date.now()), logFile: path.join(runDirectory, 'driver.log') })
      executions.push(execution)
      const markdown = await fs.readFile(results, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (markdown !== null) await fs.writeFile(results, redact(markdown, root, childEnvironment))
    } finally {
      if (execution && !execution.cleanupFailed) {
        await fs.rm(profiles, { recursive: true, force: true })
        await fs.rm(`${profiles}.prev`, { recursive: true, force: true })
      }
    }
  }
  return { code: executions.some(result => result.code !== 0) ? 1 : 0, timedOut: executions.some(result => result.timedOut),
    cleanupFailed: executions.some(result => result.cleanupFailed), log: executions.map(result => result.log).join('\n') }
}
