import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { snapshotContent, createBuildRecord, compareSnapshots, assertBuildFreshness, manifestFromFiles, validateObservedRuntime, verifyFrozenResults, atomicJson, recordBuild, beginRun, prepareLaunch, observeLaunch, closeLaunch, finishRun, readReportReference } from './index.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const bootstrapSource = entry => `import(${JSON.stringify(pathToFileURL(entry).href)});\n`
const gcSource = main => `const v8 = require('node:v8');
const vm = require('node:vm');
v8.setFlagsFromString('--expose_gc');
const collect = vm.runInNewContext('gc');
if (typeof collect !== 'function') throw new Error('Browser performance GC function is unavailable');
globalThis.__browserPerfCollectMainHeapToken = "ec05c2a8-e4dc-4149-8a53-4d6a7b0dceef";
globalThis.__browserPerfCollectMainHeap = () => { collect(); return v8.getHeapStatistics().used_heap_size / 1048576; };
require(${JSON.stringify(main)});
`
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'perf-content-proof-'))
  const write = (name, bytes) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); return file }
  execFileSync('git', ['init', '-q', root])
  write('.gitignore', 'out/\nnode_modules/\nresources/\ntests/perf/fixtures/generated/\nresults/\n')
  write('package.json', JSON.stringify({ name: 'identity-fixture', main: './out/main/index.cjs', scripts: { build: 'electron-vite build' } }))
  for (const file of ['package-lock.json', 'yarn.lock', 'electron.vite.config.ts', 'electron-builder.cjs', 'product.json']) write(file, '{}')
  write('src/main/index.ts', 'export const value = 1\n')
  write('tests/perf/lib/collector.ts', 'export const unit = "one-core"\n')
  const data = Buffer.from('complete generated fixture')
  write('tests/perf/fixtures/manifest.json', JSON.stringify({ fixtures: { 'data.txt': { bytes: data.length, sha256: sha(data) } } }))
  write('tests/perf/fixtures/generated/data.txt', data)
  write('out/main/index.cjs', 'exports.value = 1\n')
  write('out/preload/index.cjs', 'globalThis.preload = true\n')
  write('out/renderer/index.html', '<html>compiled renderer</html>')
  write('resources/native/runtime.node', 'native byte fixture')
  write('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '43.7.7', main: 'index.cjs' }))
  write('node_modules/electron/index.cjs', 'module.exports = require("node:path").join(__dirname,"dist/electron")\n')
  write('node_modules/electron/dist/version', '43.7.7')
  write('node_modules/electron/dist/electron', 'synthetic executable bytes; never executed')
  for (const name of ['playwright', '@playwright/test', 'tsx', 'esbuild']) write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0' }))
  const earlier = new Date(Date.now() - 10000)
  for (const file of ['src/main/index.ts', 'package.json', 'package-lock.json', 'yarn.lock', 'electron.vite.config.ts', 'electron-builder.cjs', 'product.json']) utimesSync(join(root, file), earlier, earlier)
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function withFixture(action) {
  const context = fixture()
  try { await action(context) } finally { context.cleanup() }
}

test('dirty current-source/frozen-artifact identity is honest and nonempty', async () => withFixture(async ({ root }) => {
  const snapshot = await snapshotContent(root)
  const record = createBuildRecord(snapshot, { sha: 'a'.repeat(40), dirty: true })
  assert.equal(record.dirty, true)
  assert.equal(record.freshness.sourceBinding, 'not-compilation-attested')
  assert.ok(record.content.source.count > 0 && record.content.harness.count > 0)
  assert.equal(compareSnapshots(snapshot, await snapshotContent(root)), true)
}))

test('new nonignored untracked harness bytes cannot escape the root hash', async () => withFixture(async ({ root, write }) => {
  const before = await snapshotContent(root)
  write('tests/perf/lib/new-collector.ts', 'export const changed = true\n')
  const after = await snapshotContent(root)
  assert.throws(() => compareSnapshots(before, after), /harness content changed/)
}))

test('artifact tampering is rejected even when its mtime is preserved', async () => withFixture(async ({ root }) => {
  const before = await snapshotContent(root)
  const file = join(root, 'out/main/index.cjs')
  const stamp = statSync(file)
  writeFileSync(file, 'exports.value = 2\n')
  utimesSync(file, stamp.atime, stamp.mtime)
  const after = await snapshotContent(root)
  assert.throws(() => compareSnapshots(before, after), /artifacts content changed/)
}))

test('newer production source cannot be recorded as a fresh build', async () => withFixture(async ({ root }) => {
  const file = join(root, 'src/main/index.ts')
  const future = new Date(Date.now() + 10000)
  writeFileSync(file, 'export const value = 2\n')
  utimesSync(file, future, future)
  const snapshot = await snapshotContent(root)
  assert.throws(() => assertBuildFreshness(snapshot), /Source\/build inputs are newer/)
}))

test('missing preload and empty manifest are hard failures', async () => withFixture(async ({ root }) => {
  rmSync(join(root, 'out/preload/index.cjs'))
  await assert.rejects(snapshotContent(root), /preload entry is missing/)
  assert.throws(() => manifestFromFiles([]), /zero files/)
}))

test('temporary launch scripts are a distinct responsibility from production components', async () => withFixture(async ({ root, write }) => {
  const before = await snapshotContent(root)
  write('out/main/owned-launcher.cjs', 'require("./index.cjs")\n')
  const after = await snapshotContent(root)
  assert.equal(compareSnapshots(before, after), true)
}))

test('runtime version mismatch is rejected independently of matching artifact bytes', async () => withFixture(async ({ root }) => {
  const snapshot = await snapshotContent(root)
  const main = snapshot.artifacts.files.find(file => file.role === 'production.main')
  const run = { pre: { content: snapshot } }
  const evidence = { status: 'closed', observed: { electron: '29.4.6', chromium: '122.0', node: '20.9.0', pid: 123, execPath: snapshot.runtime.executable }, launchExecutable: snapshot.runtime.executable, productionMain: { before: main, after: main }, loaders: [{ role: 'bootstrap', bytes: 1, sha256: sha('x') }] }
  assert.throws(() => validateObservedRuntime(run, evidence), /version\/PID mismatches/)
}))

test('a preflight-only result cannot acquire a completed proof retroactively', async () => withFixture(async ({ root }) => {
  const file = join(root, 'results/.identity/run.json')
  atomicJson(file, { runId: 'test-run', status: 'running', pre: {} })
  const result = { build: { dirty: true, contentIdentity: { runId: 'test-run', witnessPath: file } } }
  await assert.rejects(verifyFrozenResults(root, [result]), /no successful postflight/)
}))

test('a complete runtime witness requires the owned bootstrap role and actual arguments', async () => withFixture(async ({ root, write }) => {
  const snapshot = await snapshotContent(root)
  const main = snapshot.artifacts.files.find(file => file.role === 'production.main')
  const mainPath = join(root, 'out/main/index.cjs')
  const bootstrap = write('out/main/bootstrap.cjs', bootstrapSource(mainPath))
  const content = readFileSync(bootstrap, 'utf8')
  const canonicalBootstrap = realpathSync(bootstrap)
  const canonicalMain = realpathSync(mainPath)
  rmSync(bootstrap)
  const run = { pre: { content: snapshot } }
  const evidence = { status: 'closed', observed: { electron: '43.7.7', chromium: '150.0', node: '24.21.0', pid: 123,
    execPath: snapshot.runtime.executable, appPath: join(root, 'out/main'), appVersion: '1.0.0', appData: join(root, 'profile'), userData: join(root, 'profile/user') },
    launchExecutable: snapshot.runtime.executable, productionMain: { path: mainPath, canonicalPath: canonicalMain, before: main, after: main },
    entryPath: mainPath, canonicalEntryPath: canonicalMain, loaders: [{ role: 'bootstrap', bytes: Buffer.byteLength(content), sha256: sha(content), content, actualPath: bootstrap, canonicalPath: canonicalBootstrap, releasedAt: new Date().toISOString() }], actualArgs: [bootstrap] }
  assert.equal(validateObservedRuntime(run, evidence), true)
  assert.throws(() => validateObservedRuntime(run, { ...evidence, loaders: [] }), /bootstrap\/GC launcher/)
  assert.throws(() => validateObservedRuntime(run, { ...evidence, actualArgs: [] }), /Actual launch arguments/)
}))

test('measurement commands are not classified as production build dependencies', async () => withFixture(async ({ root, write }) => {
  const before = await snapshotContent(root)
  write('scripts/run-perf.mjs', 'export const actualMeasurement = true\n')
  const after = await snapshotContent(root)
  assert.equal(before.inputs.rootSha256, after.inputs.rootSha256)
  assert.notEqual(before.harness.rootSha256, after.harness.rootSha256)
  assert.doesNotThrow(() => assertBuildFreshness(after))
}))

test('a complete synthetic run authenticates released GC/bootstrap archives and preserves dirty true', async () => withFixture(async ({ root, write }) => {
  const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repository, encoding: 'utf8' }).trim()
  write('.git/objects/info/alternates', resolve(repository, common, 'objects') + '\n')
  execFileSync('git', ['update-ref', 'HEAD', head], { cwd: root })
  const record = await recordBuild(root)
  assert.equal(record.dirty, true)
  const directory = join(root, 'results/run')
  const session = await beginRun(root, directory)
  const main = join(root, 'out/main/index.cjs')
  const wrapper = write('out/main/actual-owned-gc.cjs', gcSource(main))
  const bootstrap = write('out/main/actual-owned-bootstrap.cjs', bootstrapSource(wrapper))
  const launch = await prepareLaunch(session.file, { productionMain: main, entryPath: wrapper, bootstrap, launchArgs: [bootstrap] })
  const runtime = session.run.pre.content.runtime
  observeLaunch(launch, { electron: '43.7.7', chromium: '150.0', node: '24.21.0', pid: 123, execPath: runtime.executable,
    appPath: dirname(main), appVersion: '1.0.0', appData: join(root, 'profile'), userData: join(root, 'profile/user') }, runtime.executable, [runtime.executable, bootstrap])
  closeLaunch(launch)
  rmSync(wrapper)
  rmSync(bootstrap)
  await finishRun(session.file)
  const report = { build: { sha: record.sha, dirty: true, artifactKind: 'electron-vite', verified: true, contentIdentity: readReportReference(session.file).identity } }
  assert.equal((await verifyFrozenResults(root, [report], { resultDir: directory })).status, 'complete')
  await assert.rejects(verifyFrozenResults(root, [{ build: { ...report.build, dirty: false } }], { resultDir: directory }), /Git\/dirty\/artifact identity/)
  const proof = JSON.parse(readFileSync(launch, 'utf8'))
  assert.equal(proof.loaders.length, 2)
  assert.equal(validateObservedRuntime(JSON.parse(readFileSync(session.file, 'utf8')), proof), true)
  const archiveTamper = structuredClone(proof)
  archiveTamper.loaders[1].content += 'globalThis.tampered = true\n'
  assert.throws(() => validateObservedRuntime(JSON.parse(readFileSync(session.file, 'utf8')), archiveTamper), /launcher byte evidence/)
  const targetTamper = structuredClone(proof)
  targetTamper.loaders[1].content = gcSource(join(root, 'other-main.cjs'))
  targetTamper.loaders[1].sha256 = sha(targetTamper.loaders[1].content)
  targetTamper.loaders[1].bytes = Buffer.byteLength(targetTamper.loaders[1].content)
  assert.throws(() => validateObservedRuntime(JSON.parse(readFileSync(session.file, 'utf8')), targetTamper), /token and production main/)
  write('out/main/actual-owned-gc.cjs', gcSource(main))
  assert.throws(() => validateObservedRuntime(JSON.parse(readFileSync(session.file, 'utf8')), proof), /was not released/)
  rmSync(wrapper)
  proof.observed.electron = '29.4.6'
  atomicJson(launch, proof)
  await assert.rejects(verifyFrozenResults(root, [report], { resultDir: directory }), /launch evidence changed/)
}))
