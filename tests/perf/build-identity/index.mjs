import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SCHEMA_VERSION = 2
export const SIDECAR_NAME = '.build-identity.json'
export const ARTIFACT_LAYOUTS = [
  { dir: 'out/main', kind: 'electron-vite' },
  { dir: 'dist/mac-arm64', kind: 'packaged-mac-arm64' },
  { dir: 'dist/mac', kind: 'packaged-mac-x64' },
  { dir: 'dist/win-unpacked', kind: 'packaged-win' },
  { dir: 'dist/linux-unpacked', kind: 'packaged-linux' },
]
const BUILD_FILES = ['package.json', 'package-lock.json', 'yarn.lock', 'electron.vite.config.ts', 'electron-builder.cjs', 'product.json']
const HARNESS_ROOTS = ['tests/perf/lib/', 'tests/perf/specs/', 'tests/perf/fixtures/', 'tests/perf/mock/', 'tests/perf/reporter/', 'tests/perf/build-identity/', 'tests/e2e/fixtures/']
const HARNESS_FILES = new Set(['tests/playwright.config.ts', 'tests/perf/record-build.mjs', 'tests/perf/verify-run.ts', 'tests/perf/compare.mjs', 'scripts/run-perf.mjs', 'scripts/release-perf-check.mjs'])
const SHA = /^[0-9a-f]{64}$/
const posix = value => value.split(sep).join('/')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const requireValue = (condition, message) => { if (!condition) throw new Error(`[PerfIdentity] ${message}`) }

export function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
}

export function gitCatalogue(root) {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort()
}

export function gitContext(root) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  requireValue(/^[0-9a-f]{40,64}$/.test(sha), 'Git revision is unknown')
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], { cwd: root, encoding: 'utf8' })
  return { sha, dirty: status.length > 0, statusSha256: hashBytes(status) }
}

function filesUnder(directory) {
  requireValue(existsSync(directory), `Required component is missing: ${directory}`)
  const files = []
  const visited = new Set()
  function visit(dir) {
    const actual = realpathSync(dir)
    if (visited.has(actual)) return
    visited.add(actual)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      const stat = statSync(file)
      if (stat.isDirectory()) visit(file)
      else if (stat.isFile()) files.push(file)
      else throw new Error(`[PerfIdentity] Unsupported component member: ${file}`)
    }
  }
  visit(directory)
  return files.sort()
}

export async function fingerprintFile(file, name, role) {
  requireValue(existsSync(file), `${role} file is missing: ${name}`)
  const before = statSync(file)
  requireValue(before.isFile(), `${role} is not a regular file: ${name}`)
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  const after = statSync(file)
  requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino, `${role} changed while hashing: ${name}`)
  return { path: posix(name), role, bytes: before.size, sha256: hash.digest('hex'), mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, inode: before.ino }
}

export function manifestFromFiles(files) {
  const entries = [...files].sort((a, b) => `${a.role}\0${a.path}` < `${b.role}\0${b.path}` ? -1 : 1)
  requireValue(entries.length > 0, 'Manifest contains zero files')
  const keys = new Set()
  for (const entry of entries) {
    requireValue(typeof entry.path === 'string' && entry.path.length > 0 && !isAbsolute(entry.path) && !entry.path.split('/').includes('..'), 'Manifest has an invalid relative path')
    requireValue(typeof entry.role === 'string' && entry.role.length > 0 && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && SHA.test(entry.sha256), `Manifest entry is incomplete: ${entry.path}`)
    const key = `${entry.role}\0${entry.path}`
    requireValue(!keys.has(key), `Manifest has a duplicate member: ${entry.path}`)
    keys.add(key)
  }
  const canonical = entries.map(({ path, role, bytes, sha256 }) => ({ path, role, bytes, sha256 }))
  return { count: entries.length, rootSha256: hashBytes(JSON.stringify(canonical)), files: entries }
}

export function validateManifest(manifest, role) {
  requireValue(manifest && Array.isArray(manifest.files), `${role} manifest is missing`)
  const recomputed = manifestFromFiles(manifest.files)
  requireValue(manifest.count === recomputed.count && manifest.rootSha256 === recomputed.rootSha256, `${role} manifest count or root hash is invalid`)
  return recomputed
}

async function projectManifest(root, files) {
  const entries = []
  for (const [file, role] of files) entries.push(await fingerprintFile(file, relative(root, file), role))
  return manifestFromFiles(entries)
}

function buildInputPaths(root) {
  const required = BUILD_FILES.map(file => [join(root, file), 'build-input'])
  const packageData = json(join(root, 'package.json'))
  requireValue(typeof packageData.scripts?.build === 'string', 'Production build command is missing')
  const entryFiles = new Set(['electron.vite.config.ts', 'electron-builder.cjs'])
  const commands = ['build']
  const visitedCommands = new Set()
  while (commands.length) {
    const name = commands.pop()
    if (visitedCommands.has(name)) continue
    visitedCommands.add(name)
    const command = packageData.scripts[name]
    requireValue(typeof command === 'string', `Referenced production build command is missing: ${name}`)
    for (const match of command.matchAll(/npm\s+run\s+([\w:-]+)/g)) commands.push(match[1])
    for (const match of command.matchAll(/(?:^|[;&|]\s*|\s)(?:node|bash|sh|python3?)\s+([^\s;&|]+\.(?:mjs|cjs|js|ts|sh|py))/g)) entryFiles.add(match[1].replace(/^['"]|['"]$/g, ''))
  }
  for (const hook of ['beforePack', 'afterPack', 'afterSign']) if (typeof packageData.build?.[hook] === 'string') entryFiles.add(packageData.build[hook])
  const pending = [...entryFiles].map(file => resolve(root, file))
  const buildCode = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (buildCode.has(file)) continue
    requireValue(existsSync(file), `Production build entry/dependency is missing: ${relative(root, file)}`)
    buildCode.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), match[1])
      const candidates = [target, target.replace(/\.js$/, '.ts'), `${target}.mjs`, `${target}.cjs`, `${target}.js`, `${target}.ts`, join(target, 'index.mjs'), join(target, 'index.ts')]
      const dependency = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile())
      requireValue(dependency, `Production build dependency cannot be resolved: ${relative(root, file)} -> ${match[1]}`)
      pending.push(dependency)
    }
    const runtimeRelative = posix(relative(root, file))
    if (runtimeRelative.startsWith('runtimes/')) {
      const directory = join(root, runtimeRelative.split('/').slice(0, 2).join('/'), 'src')
      if (existsSync(directory)) for (const sourceFile of filesUnder(directory)) pending.push(sourceFile)
    }
  }
  return [...required, ...[...buildCode].filter(file => !BUILD_FILES.includes(posix(relative(root, file)))).map(file => [file, 'build-tooling'])]
}

function productionArtifactPaths(root, artifactDir) {
  const layout = ARTIFACT_LAYOUTS.find(entry => entry.dir === artifactDir)
  requireValue(layout, `Artifact kind is unknown: ${artifactDir}`)
  requireValue(layout.kind === 'electron-vite', 'Frozen content recording currently requires the production electron-vite components')
  const packageMain = json(join(root, 'package.json')).main
  requireValue(typeof packageMain === 'string' && packageMain.startsWith('./out/main/'), 'Production main entry is not declared under out/main')
  const main = resolve(root, packageMain)
  const entries = [[main, 'production.main']]
  if (existsSync(main + '.map')) entries.push([main + '.map', 'production.main-map'])
  for (const component of ['chunks', 'worker']) {
    const directory = join(root, 'out/main', component)
    if (existsSync(directory)) for (const file of filesUnder(directory)) entries.push([file, `production.main-${component}`])
  }
  for (const component of ['preload', 'renderer']) {
    const directory = join(root, 'out', component)
    for (const file of filesUnder(directory)) entries.push([file, `production.${component}`])
  }
  requireValue(entries.some(([file, role]) => role === 'production.preload' && basename(file).startsWith('index.')), 'Production preload entry is missing')
  requireValue(entries.some(([file, role]) => role === 'production.renderer' && basename(file) === 'index.html'), 'Production renderer entry is missing')
  if (existsSync(join(root, 'src/preload/browser-host.ts'))) {
    requireValue(existsSync(join(root, 'out/preload/browser-host.cjs')), 'Declared browser host preload is missing')
    requireValue(existsSync(join(root, 'out/renderer/browser-host.html')), 'Declared browser host renderer is missing')
  }
  return { layout, main, entries }
}

function harnessPaths(root, catalogue) {
  return catalogue.filter(file => (HARNESS_FILES.has(file) || HARNESS_ROOTS.some(prefix => file.startsWith(prefix))) && existsSync(join(root, file))).map(file => [join(root, file), 'measurement.harness'])
}

async function generatedFixtures(root) {
  const manifest = json(join(root, 'tests/perf/fixtures/manifest.json')).fixtures
  requireValue(manifest && Object.keys(manifest).length > 0, 'Generated fixture manifest is empty')
  const entries = []
  for (const name of Object.keys(manifest).sort()) {
    requireValue(name === basename(name), `Invalid generated fixture name: ${name}`)
    const file = join(root, 'tests/perf/fixtures/generated', name)
    const entry = await fingerprintFile(file, relative(root, file), 'measurement.fixture')
    requireValue(entry.bytes === manifest[name].bytes && entry.sha256 === manifest[name].sha256, `Generated fixture bytes differ from their registered manifest: ${name}`)
    entries.push(entry)
  }
  return manifestFromFiles(entries)
}

async function runtimeDistribution(root) {
  const require = createRequire(join(root, 'package.json'))
  const executable = realpathSync(require('electron'))
  const packagePath = require.resolve('electron/package.json')
  const packageRoot = dirname(packagePath)
  const distribution = join(packageRoot, 'dist')
  const version = readFileSync(join(distribution, 'version'), 'utf8').trim().replace(/^v/, '')
  requireValue(version === json(packagePath).version, 'Electron version file and package disagree')
  const entries = []
  for (const file of filesUnder(distribution)) entries.push(await fingerprintFile(file, `electron-distribution/${posix(relative(distribution, file))}`, 'runtime.electron'))
  entries.push(await fingerprintFile(packagePath, 'electron-package/package.json', 'runtime.electron-package'))
  const executableEntry = entries.find(entry => entry.path === `electron-distribution/${posix(relative(distribution, executable))}`)
  requireValue(executableEntry, 'Actual Electron executable was not fingerprinted')
  const tooling = {}
  for (const name of ['playwright', '@playwright/test', 'esbuild']) {
    const file = require.resolve(`${name}/package.json`)
    const metadata = json(file)
    tooling[name] = { version: metadata.version, packageSha256: hashBytes(readFileSync(file)) }
  }
  return { expectedElectron: version, executable, executableSha256: executableEntry.sha256, distributionRoot: distribution, manifest: manifestFromFiles(entries), tooling, collectorNode: process.versions.node, platform: process.platform, arch: process.arch }
}

async function extraRuntimeResources(root) {
  const entries = []
  for (const directory of ['resources', 'node_modules/better-sqlite3', 'node_modules/node-pty', 'node_modules/@img']) {
    const absolute = join(root, directory)
    if (!existsSync(absolute)) continue
    for (const file of filesUnder(absolute)) entries.push([file, 'runtime.resource'])
  }
  requireValue(entries.length > 0, 'Actual external/native runtime resources were not found')
  return projectManifest(root, entries)
}

export async function snapshotContent(root, { artifactDir = 'out/main', includeRuntime = true } = {}) {
  root = realpathSync(root)
  const catalogue = gitCatalogue(root)
  const production = productionArtifactPaths(root, artifactDir)
  const source = await projectManifest(root, filesUnder(join(root, 'src')).map(file => [file, 'production.source']))
  const inputs = await projectManifest(root, buildInputPaths(root))
  const artifacts = await projectManifest(root, production.entries)
  const harness = await projectManifest(root, harnessPaths(root, catalogue))
  const fixtures = await generatedFixtures(root)
  const external = includeRuntime ? await extraRuntimeResources(root) : null
  const runtime = includeRuntime ? await runtimeDistribution(root) : null
  const currentHarnessPaths = harnessPaths(root, gitCatalogue(root)).map(([file]) => file)
  requireValue(equal(harness.files.map(entry => resolve(root, entry.path)).sort(), currentHarnessPaths.sort()), 'Measurement harness membership changed while taking its snapshot')
  requireValue(equal(source.files.map(entry => resolve(root, entry.path)).sort(), filesUnder(join(root, 'src'))), 'Source membership changed while taking its snapshot')
  requireValue(equal(artifacts.files.map(entry => resolve(root, entry.path)).sort(), productionArtifactPaths(root, artifactDir).entries.map(([file]) => file).sort()), 'Production artifact membership changed while taking its snapshot')
  for (const manifest of [source, inputs, artifacts, harness, fixtures, ...(external ? [external] : [])]) {
    for (const entry of manifest.files) {
      const stamp = statSync(resolve(root, entry.path))
      requireValue(stamp.size === entry.bytes && stamp.mtimeMs === entry.mtimeMs && stamp.ctimeMs === entry.ctimeMs && stamp.ino === entry.inode, `Content changed after being hashed: ${entry.role}:${entry.path}`)
    }
  }
  return { source, inputs, artifacts, harness, fixtures, external, runtime, artifactKind: production.layout.kind, artifactDir, productionMain: posix(relative(root, production.main)), sampledAt: new Date().toISOString() }
}

export function assertBuildFreshness(snapshot) {
  const main = snapshot.artifacts.files.find(entry => entry.role === 'production.main')
  requireValue(main && Number.isFinite(main.mtimeMs), 'Production main build time is unknown')
  const compilationInputs = [...snapshot.source.files, ...snapshot.inputs.files.filter(entry => ['package.json', 'package-lock.json', 'yarn.lock', 'electron.vite.config.ts', 'product.json'].includes(entry.path))]
  const stale = compilationInputs.filter(entry => entry.mtimeMs > main.mtimeMs)
  requireValue(stale.length === 0, `Source/build inputs are newer than the compiled main: ${stale.map(entry => entry.path).join(', ')}`)
  return { kind: 'current-content-and-build-freshness', sourceBinding: 'not-compilation-attested', mainMtimeMs: main.mtimeMs, newestInputMtimeMs: Math.max(...compilationInputs.map(entry => entry.mtimeMs)) }
}

export function createBuildRecord(snapshot, git) {
  for (const role of ['source', 'inputs', 'artifacts', 'harness', 'fixtures']) validateManifest(snapshot[role], role)
  requireValue(snapshot.runtime && snapshot.external, 'Actual runtime/resource content evidence is missing')
  validateManifest(snapshot.runtime.manifest, 'runtime')
  validateManifest(snapshot.external, 'external')
  requireValue(git && typeof git.dirty === 'boolean' && /^[0-9a-f]{40,64}$/.test(git.sha), 'Build Git context is incomplete')
  const freshness = assertBuildFreshness(snapshot)
  return { schemaVersion: SCHEMA_VERSION, sha: git.sha, dirty: git.dirty, git, artifactKind: snapshot.artifactKind, recordedAt: new Date().toISOString(), freshness, content: snapshot }
}

export function compareSnapshots(recorded, current, { includeHarness = true } = {}) {
  const roles = ['source', 'inputs', 'artifacts', 'fixtures', ...(includeHarness ? ['harness'] : [])]
  if (recorded.external || current.external) roles.push('external')
  for (const role of roles) {
    validateManifest(recorded[role], role)
    validateManifest(current[role], role)
    requireValue(recorded[role].rootSha256 === current[role].rootSha256 && recorded[role].count === current[role].count, `${role} content changed since the frozen record`)
  }
  requireValue(recorded.artifactKind === current.artifactKind && recorded.productionMain === current.productionMain, 'Production artifact kind/entry changed')
  if (recorded.runtime || current.runtime) {
    requireValue(recorded.runtime && current.runtime, 'Actual runtime manifest is missing')
    validateManifest(recorded.runtime.manifest, 'runtime')
    validateManifest(current.runtime.manifest, 'runtime')
    requireValue(recorded.runtime.manifest.rootSha256 === current.runtime.manifest.rootSha256 && equal(recorded.runtime.tooling, current.runtime.tooling) && recorded.runtime.expectedElectron === current.runtime.expectedElectron && recorded.runtime.collectorNode === current.runtime.collectorNode, 'Actual Electron or measurement tooling content changed')
  }
  return true
}

export async function recordBuild(root, { artifactDir = 'out/main' } = {}) {
  const snapshot = await snapshotContent(root, { artifactDir })
  const record = createBuildRecord(snapshot, gitContext(root))
  atomicJson(join(root, artifactDir, SIDECAR_NAME), record)
  return record
}

export async function verifyBuild(root, { artifactDir = 'out/main' } = {}) {
  const record = json(join(root, artifactDir, SIDECAR_NAME))
  requireValue(record.schemaVersion === SCHEMA_VERSION, 'Build has no complete content fingerprint schema')
  const current = await snapshotContent(root, { artifactDir })
  assertBuildFreshness(current)
  compareSnapshots(record.content, current)
  return { record, current, git: gitContext(root) }
}

export async function beginRun(root, resultDir, { artifactDir = 'out/main' } = {}) {
  const verified = await verifyBuild(root, { artifactDir })
  const runId = randomUUID()
  const directory = join(resolve(resultDir), '.identity', runId)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'run.json')
  const recordPath = join(directory, 'build.json')
  atomicJson(recordPath, verified.record)
  const run = { schemaVersion: SCHEMA_VERSION, mode: 'frozen-content', runId, projectRoot: realpathSync(root), resultDir: resolve(resultDir), artifactDir, recordPath, recordSha256: hashBytes(readFileSync(recordPath)), pre: { checkedAt: new Date().toISOString(), content: verified.current, git: verified.git }, launches: [], status: 'running' }
  atomicJson(file, run)
  atomicJson(join(directory, 'reference.json'), { schemaVersion: SCHEMA_VERSION, sha: verified.record.sha, dirty: verified.record.dirty || verified.git.dirty, artifactKind: verified.current.artifactKind, identity: referenceFor(run, file) })
  atomicJson(join(directory, 'launch-context.json'), { schemaVersion: SCHEMA_VERSION, status: 'running', runId, projectRoot: run.projectRoot, productionMain: verified.current.productionMain, main: verified.current.artifacts.files.find(entry => entry.role === 'production.main'), checkedAt: run.pre.checkedAt })
  return { file, run }
}

function referenceFor(run, file) {
  return { runId: run.runId, witnessPath: file, recordSha256: run.recordSha256, sourceSha256: run.pre.content.source.rootSha256, artifactSha256: run.pre.content.artifacts.rootSha256, harnessSha256: run.pre.content.harness.rootSha256, fixtureSha256: run.pre.content.fixtures.rootSha256, expectedElectron: run.pre.content.runtime.expectedElectron }
}

export function readBuildReference(file) {
  const reference = json(join(dirname(file), 'reference.json'))
  requireValue(reference.schemaVersion === SCHEMA_VERSION && typeof reference.dirty === 'boolean' && reference.identity?.witnessPath === file && SHA.test(reference.identity?.recordSha256), 'Small run identity reference is incomplete')
  return reference
}

export function readRunReference(file) { return readBuildReference(file).identity }

export function readReportReference(file) {
  const reference = readBuildReference(file)
  const observation = json(join(dirname(file), `worker-${process.pid}.runtime.json`))
  requireValue(observation.workerPid === process.pid && observation.launchId && observation.observed, 'Report has no runtime observation owned by this measurement worker')
  return { ...reference, identity: { ...reference.identity, launchId: observation.launchId, observedRuntime: observation.observed } }
}

export function validateObservedRuntime(run, evidence) {
  const expected = run.pre.content.runtime
  requireValue(expected && evidence && evidence.observed, 'Actual runtime observation is missing')
  const observed = evidence.observed
  requireValue(observed.electron === expected.expectedElectron && typeof observed.chromium === 'string' && observed.chromium.length > 0 && typeof observed.node === 'string' && observed.node.length > 0 && Number.isSafeInteger(observed.pid) && observed.pid > 0, 'Actual runtime version/PID mismatches the recorded runtime')
  requireValue(realpathSync(observed.execPath) === realpathSync(expected.executable) && realpathSync(evidence.launchExecutable) === realpathSync(expected.executable), 'Actual launch/observed executable differs from the fingerprinted runtime')
  requireValue(['appPath', 'appVersion', 'appData', 'userData'].every(key => typeof observed[key] === 'string' && observed[key].length > 0), 'Actual app path/version observation is incomplete')
  const main = run.pre.content.artifacts.files.find(entry => entry.role === 'production.main')
  requireValue(main && evidence.productionMain?.before?.sha256 === main.sha256 && evidence.productionMain?.after?.sha256 === main.sha256, 'Actual production main before/after hashes mismatch')
  requireValue(evidence.productionMain.canonicalPath === realpathSync(evidence.productionMain.path) && typeof evidence.canonicalEntryPath === 'string' && isAbsolute(evidence.canonicalEntryPath), 'Launch canonical entry/main path evidence is incomplete')
  requireValue(Array.isArray(evidence.loaders) && evidence.loaders.filter(loader => loader.role === 'bootstrap').length === 1 && evidence.loaders.every(loader => SHA.test(loader.sha256) && loader.bytes > 0 && ['bootstrap', 'measurement-entry'].includes(loader.role) && typeof loader.content === 'string' && Buffer.byteLength(loader.content) === loader.bytes && hashBytes(loader.content) === loader.sha256 && typeof loader.canonicalPath === 'string' && isAbsolute(loader.canonicalPath) && typeof loader.actualPath === 'string' && isAbsolute(loader.actualPath)), 'Owned bootstrap/GC launcher byte evidence is incomplete')
  const bootstrap = evidence.loaders.find(loader => loader.role === 'bootstrap')
  requireValue(bootstrap.content.endsWith(`import(${JSON.stringify(pathToFileURL(evidence.entryPath).href)});\n`), 'Owned bootstrap archive does not load the recorded entry')
  const measurementEntries = evidence.loaders.filter(loader => loader.role === 'measurement-entry')
  if (evidence.canonicalEntryPath !== evidence.productionMain.canonicalPath) {
    requireValue(measurementEntries.length === 1 && measurementEntries[0].canonicalPath === evidence.canonicalEntryPath, 'Owned GC/measurement entry role is missing')
    const loader = measurementEntries[0]
    requireValue(loader.content.endsWith(`require(${JSON.stringify(evidence.productionMain.path)});\n`) && /^globalThis\.__browserPerfCollectMainHeapToken = "[0-9a-f-]{36}";$/m.test(loader.content), 'Owned GC launcher archive does not bind its token and production main')
  } else requireValue(measurementEntries.length === 0, 'Persistent production entry has an unexpected owned measurement loader')
  requireValue(Array.isArray(evidence.actualArgs) && evidence.loaders.every(loader => loader.role !== 'bootstrap' || evidence.actualArgs.includes(loader.actualPath)), 'Actual launch arguments did not use the owned bootstrap bytes')
  requireValue(evidence.status === 'closed', 'Actual launch has no complete close witness')
  requireValue(evidence.loaders.every(loader => typeof loader.releasedAt === 'string' && !lstatSync(loader.actualPath, { throwIfNoEntry: false }) && !lstatSync(loader.canonicalPath, { throwIfNoEntry: false })), 'Owned temporary launcher was not released after close')
  return true
}

export async function finishRun(file) {
  const run = json(file)
  try {
    const current = await snapshotContent(run.projectRoot, { artifactDir: run.artifactDir })
    compareSnapshots(run.pre.content, current)
    const launchFiles = readdirSync(dirname(file)).filter(name => name.endsWith('.launch.json'))
    requireValue(launchFiles.length > 0, 'No actual runtime launch was observed')
    const launches = launchFiles.map(name => json(join(dirname(file), name)))
    const actualMain = current.artifacts.files.find(entry => entry.role === 'production.main')
    for (const [index, evidence] of launches.entries()) {
      requireValue(evidence.status === 'closed', 'Actual launch has no owned close witness')
      evidence.productionMain.after = { ...actualMain, hashVerifiedAt: current.sampledAt }
      for (const loader of evidence.loaders) {
        requireValue(!lstatSync(loader.actualPath, { throwIfNoEntry: false }) && !lstatSync(loader.canonicalPath, { throwIfNoEntry: false }), 'Owned temporary launcher was not released after close')
        loader.releasedAt = current.sampledAt
      }
      validateObservedRuntime(run, evidence)
      atomicJson(join(dirname(file), launchFiles[index]), evidence)
    }
    run.post = { checkedAt: new Date().toISOString(), content: current, git: gitContext(run.projectRoot) }
    run.launches = launchFiles.map(name => ({ file: name, sha256: hashBytes(readFileSync(join(dirname(file), name))) }))
    run.status = 'complete'
  } catch (error) {
    run.status = 'failed'
    run.error = error instanceof Error ? error.message : String(error)
    atomicJson(file, run)
    throw error
  }
  atomicJson(file, run)
  const context = json(join(dirname(file), 'launch-context.json'))
  context.status = run.status
  atomicJson(join(dirname(file), 'launch-context.json'), context)
  return run
}

export async function prepareLaunch(runFile, { productionMain, entryPath, bootstrap, launchArgs }) {
  const run = json(join(dirname(runFile), 'launch-context.json'))
  requireValue(run.status === 'running', 'Runtime launch began outside the authenticated run')
  const id = randomUUID()
  const file = join(dirname(runFile), `${id}.launch.json`)
  const expected = run.main
  const canonicalMainPath = realpathSync(productionMain)
  const canonicalEntryPath = realpathSync(entryPath)
  requireValue(expected && canonicalMainPath === realpathSync(join(run.projectRoot, expected.path)), 'Launch production main path differs from preflight')
  const stamp = statSync(productionMain)
  requireValue(stamp.size === expected.bytes && stamp.mtimeMs === expected.mtimeMs, 'Launch production main changed after preflight')
  const main = { ...expected, hashVerifiedAt: run.checkedAt }
  const loaders = []
  for (const [path, role] of [[bootstrap, 'bootstrap'], ...(canonicalEntryPath === canonicalMainPath ? [] : [[entryPath, 'measurement-entry']])]) {
    const actual = await fingerprintFile(path, basename(path), role)
    const content = readFileSync(path, 'utf8')
    requireValue(hashBytes(content) === actual.sha256 && Buffer.byteLength(content) === actual.bytes, 'Owned launcher changed after its launch fingerprint')
    loaders.push({ ...actual, actualPath: path, canonicalPath: realpathSync(path), content })
  }
  const evidence = { schemaVersion: SCHEMA_VERSION, id, runId: run.runId, workerPid: process.pid, status: 'prepared', preparedAt: new Date().toISOString(), productionMain: { path: productionMain, canonicalPath: canonicalMainPath, before: main }, entryPath, canonicalEntryPath, loaders, launchArgs }
  atomicJson(file, evidence)
  return file
}

export function observeLaunch(file, observed, launchExecutable, actualArgs) {
  const evidence = json(file)
  evidence.observed = observed
  evidence.launchExecutable = launchExecutable
  evidence.actualArgs = actualArgs
  evidence.status = 'observed'
  atomicJson(file, evidence)
  atomicJson(join(dirname(file), `worker-${evidence.workerPid}.runtime.json`), { workerPid: evidence.workerPid, launchId: evidence.id, observed })
}

export function closeLaunch(file) {
  const evidence = json(file)
  try {
    const stamp = statSync(evidence.productionMain.path)
    requireValue(stamp.size === evidence.productionMain.before.bytes && stamp.mtimeMs === evidence.productionMain.before.mtimeMs, 'Production main metadata changed during the owned launch')
    evidence.status = 'closed'
    evidence.closedAt = new Date().toISOString()
    evidence.productionMain.after = null
  } catch (error) {
    evidence.status = 'failed'
    evidence.error = error instanceof Error ? error.message : String(error)
    atomicJson(file, evidence)
    throw error
  }
  atomicJson(file, evidence)
}

export function failLaunch(file, error) {
  const evidence = json(file)
  evidence.status = 'failed'
  evidence.error = error instanceof Error ? error.message : String(error)
  atomicJson(file, evidence)
}

export async function verifyFrozenResults(root, results, { resultDir, compareTo } = {}) {
  requireValue(Array.isArray(results) && results.length > 0, 'Frozen comparison contains zero reports')
  const references = results.map(result => result.build?.contentIdentity)
  requireValue(references.every(reference => reference && reference.runId && reference.witnessPath), 'A report is missing its content-authenticated identity reference')
  requireValue(new Set(references.map(reference => reference.runId)).size === 1, 'Reports mix different authenticated runs')
  const reference = references[0]
  const run = json(reference.witnessPath)
  requireValue(run.status === 'complete' && run.post, 'Run has no successful postflight content witness')
  requireValue(run.projectRoot === realpathSync(root) && (!resultDir || run.resultDir === resolve(resultDir)), 'Run witness belongs to another project/results directory')
  requireValue(hashBytes(readFileSync(run.recordPath)) === run.recordSha256, 'Frozen build record was modified after preflight')
  const record = json(run.recordPath)
  requireValue(record.schemaVersion === SCHEMA_VERSION && typeof record.dirty === 'boolean' && /^[0-9a-f]{40,64}$/.test(record.sha), 'Frozen build identity fields are incomplete')
  for (const result of results) requireValue(result.build?.verified === true && result.build.sha === record.sha && result.build.dirty === (record.dirty || run.pre.git.dirty) && result.build.artifactKind === run.pre.content.artifactKind, 'Report Git/dirty/artifact identity does not match the authenticated run')
  compareSnapshots(run.pre.content, run.post.content)
  const current = await snapshotContent(root, { artifactDir: run.artifactDir })
  compareSnapshots(run.post.content, current)
  for (const ref of references) {
    const { launchId, observedRuntime, ...base } = ref
    requireValue(launchId && observedRuntime && equal(base, referenceFor(run, reference.witnessPath)), 'Report content identity does not match the completed run witness')
  }
  requireValue(run.launches.length > 0, 'Run has no owned runtime launch evidence')
  const observedLaunches = new Map()
  for (const launch of run.launches) {
    const file = join(dirname(reference.witnessPath), launch.file)
    requireValue(SHA.test(launch.sha256) && hashBytes(readFileSync(file)) === launch.sha256, 'Owned runtime launch evidence changed after postflight')
    const evidence = json(file)
    validateObservedRuntime(run, evidence)
    observedLaunches.set(evidence.id, evidence)
  }
  for (const ref of references) requireValue(observedLaunches.has(ref.launchId) && equal(observedLaunches.get(ref.launchId).observed, ref.observedRuntime), 'Report actual runtime is not bound to an owned completed launch')
  if (compareTo) {
    const other = json(compareTo)
    requireValue(other.status === 'complete' && other.post, 'Comparison arm has no completed content witness')
    compareSnapshots(other.pre.content, other.post.content)
    requireValue(hashBytes(readFileSync(other.recordPath)) === other.recordSha256 && Array.isArray(other.launches) && other.launches.length > 0, 'Comparison arm build/runtime evidence is incomplete')
    for (const launch of other.launches) {
      const file = join(dirname(compareTo), launch.file)
      requireValue(SHA.test(launch.sha256) && hashBytes(readFileSync(file)) === launch.sha256, 'Comparison arm runtime evidence changed after postflight')
      validateObservedRuntime(other, json(file))
    }
    compareSnapshots(other.post.content, await snapshotContent(other.projectRoot, { artifactDir: other.artifactDir }))
    for (const role of ['harness', 'fixtures']) requireValue(run.pre.content[role].rootSha256 === other.pre.content[role].rootSha256, `Comparison arms have different ${role} bytes`)
    requireValue(run.pre.content.artifactKind === other.pre.content.artifactKind && equal(run.pre.content.runtime.tooling, other.pre.content.runtime.tooling) && run.pre.content.runtime.collectorNode === other.pre.content.runtime.collectorNode && run.pre.content.runtime.platform === other.pre.content.runtime.platform && run.pre.content.runtime.arch === other.pre.content.runtime.arch, 'Comparison arms use different artifact kinds or measurement tooling')
  }
  return run
}
