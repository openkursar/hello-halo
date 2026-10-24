import { promises as fs } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import readline from 'node:readline'
import { once } from 'node:events'
import { startProviderBroker, liveProviders } from './provider-broker.mjs'

const execute = promisify(execFile)
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sdk = join(project, 'src/sdk/halo-sdk')
const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  'key-stdin': { type: 'boolean' }, help: { type: 'boolean' },
  provider: { type: 'string', default: 'deepseek' },
} })
if (values.help) {
  console.log('Halo SDK application acceptance: node tests/e2e/sdk/run-live.mjs [--provider deepseek|glm] [--key-stdin]. Otherwise set SDK_TEST_API_KEY. See tests/e2e/sdk/README.md.')
  process.exit(0)
}
const provider = Object.hasOwn(liveProviders, values.provider) ? liveProviders[values.provider] : undefined
if (!provider) throw new Error('Provider must be deepseek or glm')
let key = process.env.SDK_TEST_API_KEY ?? ''
if (values['key-stdin']) {
  console.log('Waiting for model credential on stdin (not saved)')
  const reader = readline.createInterface({ input: process.stdin })
  key = ''
  try {
    for await (const line of reader) { key = line; break }
  } finally {
    reader.close()
    process.stdin.pause()
  }
}
if (!key.trim()) throw new Error('SDK_TEST_API_KEY or --key-stdin is required; live integration never skips')
key = key.trim()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = join(sdk, 'validation/results', `app-${stamp}`)
await fs.mkdir(reportDir, { recursive: true })
const temporary = await fs.mkdtemp(join(tmpdir(), 'halo-app-acceptance-'))
const snapshot = join(temporary, 'app')
const sdkSnapshot = join(snapshot, 'src/sdk/halo-sdk')
const record = { startedAt: new Date().toISOString(), snapshot, provider, passed: false }
const redact = text => text.replaceAll(key, '[REDACTED]')
let broker
let child
const cancellation = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  cancellation.abort(new Error(`Application acceptance interrupted by ${signal}`))
  child?.kill('SIGTERM')
})

async function copySources(from, to, excluded) {
  const { stdout } = await execute('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: from, maxBuffer: 16 * 1024 * 1024, signal: cancellation.signal })
  const hash = createHash('sha256')
  for (const name of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
    cancellation.signal.throwIfAborted()
    if (excluded.some(prefix => name === prefix || name.startsWith(prefix + '/')) || name.split('/').some(part => part.startsWith('.env'))) continue
    const input = join(from, name)
    if (!(await fs.lstat(input)).isFile()) continue
    const content = await fs.readFile(input)
    if (content.includes(Buffer.from(key))) throw new Error('Credential found in source snapshot input')
    hash.update(name).update('\0').update(content)
    await fs.mkdir(dirname(join(to, name)), { recursive: true })
    await fs.writeFile(join(to, name), content)
  }
  return hash.digest('hex')
}

async function command(name, executable, args, cwd) {
  try {
    const result = await execute(executable, args, { cwd, timeout: 240000, maxBuffer: 16 * 1024 * 1024, signal: cancellation.signal })
    await fs.writeFile(join(reportDir, `${name}.log`), redact(result.stdout + result.stderr))
  } catch (error) {
    await fs.writeFile(join(reportDir, `${name}.log`), redact((error.stdout ?? '') + (error.stderr ?? '')))
    throw error
  }
}

try {
  record.appSource = await copySources(project, snapshot, ['node_modules', 'out', 'dist', 'resources', 'src/sdk', 'halo-local', 'halo-webank', 'tests/e2e/results', 'tests/e2e/report', 'tests/perf/results'])
  record.sdkSource = await copySources(sdk, sdkSnapshot, ['node_modules', 'dist', 'validation/results', 'swe-bench-eval'])
  await fs.mkdir(join(snapshot, 'node_modules/@hello-halo'), { recursive: true })
  for (const entry of await fs.readdir(join(project, 'node_modules'))) {
    if (entry === '@hello-halo') continue
    await fs.symlink(join(project, 'node_modules', entry), join(snapshot, 'node_modules', entry), 'dir')
  }
  await fs.symlink(sdkSnapshot, join(snapshot, 'node_modules/@hello-halo/agent-sdk'), 'dir')
  await fs.symlink(join(sdk, 'node_modules'), join(sdkSnapshot, 'node_modules'), 'dir')
  await fs.symlink(join(project, 'resources'), join(snapshot, 'resources'), 'dir')
  await fs.mkdir(join(snapshot, 'halo-local'), { recursive: true })
  await fs.symlink(join(project, 'halo-local/dist'), join(snapshot, 'halo-local/dist'), 'dir')
  await command('sdk-build', process.execPath, [join(sdk, 'node_modules/typescript/bin/tsc'), '-p', join(sdkSnapshot, 'tsconfig.json')], sdkSnapshot)
  await command('worker-build', process.execPath, [join(sdkSnapshot, 'scripts/build-worker.mjs')], sdkSnapshot)
  await command('halo-build', process.execPath, [join(project, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], snapshot)
  record.workerEntrySha256 = createHash('sha256').update(await fs.readFile(join(sdkSnapshot, 'dist/worker/entry.js'))).digest('hex')
  console.log('Isolated Halo and SDK builds completed')
  cancellation.signal.throwIfAborted()
  broker = await startProviderBroker(key, provider)
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^HALO_TEST_|^HALO_E2E_|^ELECTRON_RUN_AS_NODE$/.test(name)) delete env[name]
  Object.assign(env, {
    HALO_TEST_API_KEY: broker.token, HALO_TEST_API_URL: broker.url, HALO_TEST_PROVIDER: provider.provider,
    HALO_TEST_MODEL: provider.model, HALO_TEST_SDK_ENGINE: 'halo',
    HALO_LIVE_RESULT_JSON: join(reportDir, 'playwright.json'),
    HALO_LIVE_ARTIFACT_DIR: join(reportDir, 'artifacts'),
    HALO_LIVE_SDK_ROOT: sdkSnapshot, HALO_LIVE_WORKER_SHA: record.workerEntrySha256,
  })
  cancellation.signal.throwIfAborted()
  child = spawn(process.execPath, [join(project, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'tests/halo-sdk-live.config.ts'], {
    cwd: snapshot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const receive = chunk => {
    const text = redact(chunk.toString())
    process.stdout.write(text)
    if (output.length < 2 * 1024 * 1024) output += text.slice(0, 2 * 1024 * 1024 - output.length)
  }
  child.stdout.on('data', receive)
  child.stderr.on('data', receive)
  const [code, signal] = await once(child, 'exit')
  await fs.writeFile(join(reportDir, 'playwright.log'), output)
  const result = JSON.parse(await fs.readFile(join(reportDir, 'playwright.json'), 'utf8'))
  record.testStats = result.stats
  record.exit = { code, signal }
  record.passed = !cancellation.signal.aborted && code === 0 && result.stats.expected > 0 && result.stats.unexpected === 0 && result.stats.skipped === 0 && result.stats.flaky === 0 &&
    broker.requests.some(request => request.completed && request.status === 200)
} catch (error) {
  record.error = redact(error.stack ?? String(error))
  console.error(redact(error.message))
} finally {
  await broker?.close()
  record.interrupted = cancellation.signal.aborted
  if (record.interrupted) record.passed = false
  record.requests = broker?.requests ?? []
  record.finishedAt = new Date().toISOString()
  await fs.writeFile(join(reportDir, 'report.json'), JSON.stringify(record, null, 2))
  console.log(`Integration report: ${join(reportDir, 'report.json')}`)
  process.exitCode = record.passed ? 0 : 1
}
