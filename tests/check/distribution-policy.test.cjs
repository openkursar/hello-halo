'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { forbiddenPath, stripSourceMapComments, sanitizeStaging, assertTree } = require('../../scripts/lib/distribution-policy.cjs')

test('static packaged import checker ignores strings, builtins and computed requires', () => {
  const { staticRequires } = require('../../scripts/lib/packaged-module-resolution.cjs')
  assert.deepEqual(staticRequires(`const text = 'require("fake")'; require('node:fs'); require('jsonrepair'); require('@modelcontextprotocol/sdk/server/index.js'); require(computed);`), ['@modelcontextprotocol/sdk/server/index.js', 'jsonrepair'])
})

test('only actual JS and CSS source map comments are removed', () => {
  const source = 'const literal = "//# sourceMappingURL=data:unchanged";\nconst regex = /sourceMappingURL/;\n//# sourceMappingURL=data:application/json;base64,abc\n'
  const output = stripSourceMapComments(source, '.js')
  assert.ok(output.includes('"//# sourceMappingURL=data:unchanged"'))
  assert.ok(output.includes('/sourceMappingURL/'))
  assert.equal(output.split('\n').length, source.split('\n').length)
  assert.ok(!output.includes('base64,abc'))
  const css = 'a { content: "/*# sourceMappingURL=literal */" }\n/*# sourceMappingURL=style.css.map */'
  const clean = stripSourceMapComments(css, '.css')
  assert.ok(clean.includes('sourceMappingURL=literal'))
  assert.ok(!clean.includes('style.css.map'))
})

test('production path policy rejects developer sentinels but preserves runtime assets', () => {
  for (const file of ['out/.e2e-browser-runtime-abc/index.cjs', 'out/.acceptance-build.json', 'node_modules/a/nested/code.js.map', 'node_modules/@hello-halo/agent-sdk/.temp/snapshot.tgz', 'node_modules/@hello-halo/agent-sdk/crates/lib.rs', 'node_modules/@openai/codex-darwin-arm64/vendor/codex']) assert.ok(forbiddenPath(file), file)
  for (const file of ['resources/git-bash/PortableGit.7z.exe', 'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib', 'node_modules/cloudflared/bin/cloudflared', 'node_modules/@hello-halo/agent-sdk/dist/native/build-info.json', 'out/renderer/assets/pdf.worker.mjs']) assert.equal(forbiddenPath(file), null, file)
})

test('application staging allowlists outputs, SDK dist and production dependencies', () => {
  const { prepareDistributionStaging } = require('../../scripts/lib/distribution-staging.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-stage-input-'))
  let stage
  try {
    const put = (name, content) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content) }
    put('package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', main: 'out/main/index.cjs', build: { files: ['out/**/*'] }, scripts: { build: 'vite build' }, devDependencies: { 'dev-only': '1.0.0' }, dependencies: { '@hello-halo/agent-sdk': '1.0.0', '@parcel/watcher': '1.0.0', '@parcel/watcher-darwin-arm64': '1.0.0', 'runtime-fixture': '1.0.0' } }))
    put('node_modules/@hello-halo/agent-sdk/package.json', '{"name":"@hello-halo/agent-sdk","version":"1.0.0"}')
    put('node_modules/@hello-halo/agent-sdk/dist/index.js', 'export const value = 1;\n//# sourceMappingURL=inline.map')
    put('node_modules/@hello-halo/agent-sdk/.temp/private.tgz', 'private')
    put('node_modules/runtime-fixture/package.json', '{"name":"runtime-fixture","version":"1.0.0","main":"lib/cjs/index.js"}')
    put('node_modules/runtime-fixture/lib/cjs/package.json', '{"type":"commonjs"}')
    put('node_modules/runtime-fixture/lib/cjs/index.js', 'module.exports = 42')
    put('node_modules/dev-only/package.json', '{}')
    put('node_modules/@parcel/watcher/package.json', '{}')
    put('node_modules/@parcel/watcher/build/Release/watcher.node', 'host-native')
    put('node_modules/@parcel/watcher-darwin-arm64/package.json', '{}')
    put('node_modules/@parcel/watcher-darwin-arm64/watcher.node', 'target-native')
    put('out/main/index.cjs', 'module.exports = 1')
    put('out/preload/index.cjs', 'module.exports = 2')
    put('out/renderer/index.html', '<html>renderer</html>')
    put('out/.e2e-browser-runtime-1/fixture.cjs', 'test')
    put('resources/builtin-skills/pdf/SKILL.md', 'PDF')
    stage = prepareDistributionStaging(root)
    const stagedManifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'))
    assert.equal(require(path.join(stage, 'node_modules/runtime-fixture')), 42)
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'node_modules/runtime-fixture/lib/cjs/package.json'), 'utf8')).type, 'commonjs')
    assert.equal(stagedManifest.build, undefined)
    assert.equal(stagedManifest.devDependencies, undefined)
    assert.equal(stagedManifest.scripts, undefined)
    assert.equal(stagedManifest.main, 'out/main/index.cjs')
    assert.equal(stagedManifest.type, 'module')
    assert.equal(stagedManifest.dependencies['@hello-halo/agent-sdk'], '1.0.0')
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build)
    assert.ok(fs.existsSync(path.join(stage, 'node_modules/@hello-halo/agent-sdk/dist/index.js')))
    assert.ok(fs.existsSync(path.join(stage, 'resources/builtin-skills/pdf/SKILL.md')))
    assert.ok(!fs.existsSync(path.join(stage, 'node_modules/dev-only')))
    assert.ok(!fs.existsSync(path.join(stage, 'node_modules/@parcel/watcher/build')))
    assert.ok(fs.existsSync(path.join(stage, 'node_modules/@parcel/watcher-darwin-arm64/watcher.node')))
    assert.ok(!fs.existsSync(path.join(stage, 'out/.e2e-browser-runtime-1')))
    assert.ok(!fs.existsSync(path.join(stage, 'node_modules/@hello-halo/agent-sdk/.temp')))
    for (const entry of ['out/main/index.cjs', 'out/preload/index.cjs', 'out/renderer/index.html']) {
      assert.deepEqual(fs.readFileSync(path.join(stage, entry)), fs.readFileSync(path.join(root, entry)), entry)
    }
    assertTree(stage)
  } finally { fs.rmSync(root, { recursive: true, force: true }); if (stage) fs.rmSync(stage, { recursive: true, force: true }) }
})

test('actual ASAR and extraResources sentinels are rejected', async () => {
  const asar = require('@electron/asar')
  const { assertDistribution } = require('../../scripts/lib/distribution-scan.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-asar-sentinel-'))
  try {
    const source = path.join(root, 'source')
    const resources = path.join(root, 'resources')
    fs.mkdirSync(source); fs.mkdirSync(resources)
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = 1')
    fs.writeFileSync(path.join(source, 'arbitrary.map'), '{"version":3,"sources":["private.ts"],"mappings":""}')
    await asar.createPackage(source, path.join(resources, 'app.asar'))
    assert.throws(() => assertDistribution(resources), /source map/)
    fs.unlinkSync(path.join(source, 'arbitrary.map'))
    await asar.createPackage(source, path.join(resources, 'app.asar'))
    assertDistribution(resources)
    fs.mkdirSync(path.join(resources, 'office-runtime'))
    fs.writeFileSync(path.join(resources, 'office-runtime', 'lib.js'), 'module.exports = 1;\n//# sourceMappingURL=data:base64,test')
    assert.throws(() => assertDistribution(resources), /Source map directive/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('missing unpacked entries fail unless explicitly pruned for the target', async () => {
  const asar = require('@electron/asar')
  const { assertDistribution, isPrunedNativeEntry } = require('../../scripts/lib/distribution-scan.cjs')
  assert.equal(isPrunedNativeEntry('node_modules/@parcel/watcher-darwin-x64/watcher.node', 'darwin-arm64'), true)
  assert.equal(isPrunedNativeEntry('node_modules/@parcel/watcher-darwin-arm64/watcher.node', 'darwin-arm64'), false)
  assert.equal(isPrunedNativeEntry('node_modules/unknown/native.node', 'darwin-arm64'), false)
  assert.equal(isPrunedNativeEntry('node_modules/better-sqlite3/prebuilds/linuxmusl-arm64.node', 'darwin-arm64'), true)
  assert.equal(isPrunedNativeEntry('node_modules/better-sqlite3/prebuilds/darwin-arm64.node', 'darwin-arm64'), false)
  assert.equal(isPrunedNativeEntry('resources/dsh-runtime/node_modules/@img/sharp-darwin-x64/lib/sharp.node', 'darwin-arm64'), true)
  assert.equal(isPrunedNativeEntry('resources/dsh-runtime/node_modules/@img/sharp-darwin-arm64/lib/sharp.node', 'darwin-arm64'), false)
  assert.equal(isPrunedNativeEntry('resources/dsh-runtime/node_modules/node-pty/src/conpty.h', 'darwin-arm64'), true)
  assert.equal(isPrunedNativeEntry('resources/dsh-runtime/node_modules/node-pty/lib/index.js', 'darwin-arm64'), false)
  assert.equal(isPrunedNativeEntry('node_modules/@hello-halo/agent-sdk/dist/native/halo-sdk.darwin-arm64.node', 'darwin-arm64'), false)
  const host = `${process.platform}-${process.arch}`
  const crossTarget = ['darwin-arm64', 'darwin-x64'].find(target => target !== host)
  assert.equal(isPrunedNativeEntry('node_modules/node-pty/build/Release/spawn-helper', crossTarget), true)
  assert.equal(isPrunedNativeEntry('node_modules/node-pty/build/Release/spawn-helper', host), false)
  assert.equal(isPrunedNativeEntry('node_modules/node-pty/lib/index.js', crossTarget), false)
  const conpty = (arch) => `node_modules/node-pty/third_party/conpty/1.23.251008001/win10-${arch}/OpenConsole.exe`
  assert.equal(isPrunedNativeEntry(conpty('arm64'), 'win32-x64'), true)
  assert.equal(isPrunedNativeEntry(conpty('x64'), 'win32-x64'), false)
  assert.equal(isPrunedNativeEntry(conpty('arm64'), 'darwin-arm64'), false)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-unpacked-sentinel-'))
  try {
    const source = path.join(root, 'source')
    const resources = path.join(root, 'resources')
    const entry = 'node_modules/@parcel/watcher-darwin-x64/watcher.node'
    fs.mkdirSync(path.join(source, path.dirname(entry)), { recursive: true }); fs.mkdirSync(resources)
    fs.writeFileSync(path.join(source, entry), 'native')
    await asar.createPackageWithOptions(source, path.join(resources, 'app.asar'), { unpack: '**/*.node' })
    fs.unlinkSync(path.join(resources, 'app.asar.unpacked', entry))
    assert.doesNotThrow(() => assertDistribution(resources, { target: 'darwin-arm64' }))
    assert.throws(() => assertDistribution(resources, { target: 'darwin-x64' }), /Missing unpacked/)
    fs.writeFileSync(path.join(source, 'unknown.node'), 'native')
    await asar.createPackageWithOptions(source, path.join(resources, 'app.asar'), { unpack: '**/*.node' })
    fs.unlinkSync(path.join(resources, 'app.asar.unpacked', 'unknown.node'))
    asar.uncache(path.join(resources, 'app.asar'))
    assert.throws(() => assertDistribution(resources, { target: 'darwin-arm64' }), /Missing unpacked/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('staging sanitizes nested maps without modifying the source tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-distribution-test-'))
  try {
    const source = path.join(root, 'source')
    const stage = path.join(root, 'stage')
    fs.mkdirSync(path.join(source, 'node_modules/a'), { recursive: true })
    fs.writeFileSync(path.join(source, 'node_modules/a/index.js'), 'module.exports = 42;\n//# sourceMappingURL=index.js.map\n')
    fs.writeFileSync(path.join(source, 'node_modules/a/index.js.map'), '{}')
    fs.cpSync(source, stage, { recursive: true })
    assert.throws(() => assertTree(stage), /source map/i)
    assert.deepEqual(sanitizeStaging(stage), { removed: 1, transformed: 1 })
    assert.equal(assertTree(stage).files, 1)
    assert.ok(fs.existsSync(path.join(source, 'node_modules/a/index.js.map')))
    assert.match(fs.readFileSync(path.join(source, 'node_modules/a/index.js'), 'utf8'), /sourceMappingURL/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
