import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { buildApplication } from '../../../scripts/acceptance/lib/build.mjs'
import { packageApplication, verifyPackagedApplication } from '../../../scripts/acceptance/lib/package.mjs'

const require = createRequire(import.meta.url)

async function fixture(context, { sdk = false, behavior = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-package-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const write = async (name, value) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value) }
  await write('.gitignore', 'out/\nnode_modules/\ntests/acceptance/output/\n')
  await write('package.json', JSON.stringify({ name: 'acceptance-package-test', version: '1.0.0', main: './out/main/index.cjs', scripts: { build: 'node build.cjs' }, dependencies: { 'test-runtime': '1.0.0' }, optionalDependencies: sdk ? { '@hello-halo/agent-sdk': '1.0.0' } : {} }))
  await write('package-lock.json', '{}')
  await write('product.json', JSON.stringify({ name: 'Acceptance Package Test', appId: 'example.test', authProviders: [] }))
  await write('src/main.ts', 'export const answer = 1\n')
  await write('electron-builder.cjs', 'module.exports = {}\n')
  await write('scripts/afterPack.cjs', 'module.exports = () => {}\n')
  await write('node_modules/test-runtime/package.json', JSON.stringify({ name: 'test-runtime', version: '1.0.0' }))
  await write('node_modules/test-runtime/index.js', 'module.exports = 1\n')
  await write('build.cjs', `const fs=require('node:fs');for(const part of ['main','preload','renderer'])fs.mkdirSync('out/'+part,{recursive:true});fs.writeFileSync('out/main/index.cjs',fs.readFileSync('src/main.ts'));fs.writeFileSync('out/preload/index.cjs','preload');fs.writeFileSync('out/renderer/index.html','<main>ready</main>');`)
  for (const dependency of ['@electron/asar', 'plist', 'sanitize-filename']) {
    const destination = path.join(root, 'node_modules', dependency)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.symlink(path.dirname(require.resolve(dependency + '/package.json')), destination, 'junction')
  }
  if (sdk) {
    await write('node_modules/@hello-halo/agent-sdk/package.json', JSON.stringify({ name: '@hello-halo/agent-sdk', version: '1.0.0' }))
    await write('node_modules/@hello-halo/agent-sdk/src/index.ts', 'source SDK')
    await write('node_modules/@hello-halo/agent-sdk/dist/index.js', 'compiled SDK')
    await write('node_modules/@hello-halo/agent-sdk/dist/worker/entry.js', 'compiled worker')
    await write('node_modules/@hello-halo/agent-sdk/dist/index.js.map', 'optional source map')
  }
  await write('node_modules/electron-builder/package.json', JSON.stringify({ name: 'electron-builder', version: '0.0.0-test', bin: { 'electron-builder': './cli.cjs' } }))
  await write('node_modules/electron-builder/cli.cjs', `
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const args = process.argv.slice(2);
  const output = args.find(value => value.startsWith('-c.directories.output=')).slice('-c.directories.output='.length);
  await fs.writeFile(path.join(output, 'invocation.json'), JSON.stringify({args, signingMode:process.env.HALO_MAC_SIGN_MODE, cscDiscovery:process.env.CSC_IDENTITY_AUTO_DISCOVERY, credentialPresent:Boolean(process.env.CSC_LINK || process.env.APPLE_ID || process.env.GITHUB_TOKEN)}));
  const app = path.join(output, process.platform === 'darwin' ? 'mac-test/Acceptance Package Test.app' : 'test-unpacked');
  const resources = path.join(app, process.platform === 'darwin' ? 'Contents/Resources' : 'resources');
  const executable = path.join(app, process.platform === 'darwin' ? 'Contents/MacOS/Acceptance Package Test' : process.platform === 'win32' ? 'Acceptance Package Test.exe' : 'acceptance-package-test');
  await fs.mkdir(resources, {recursive:true}); await fs.mkdir(path.dirname(executable), {recursive:true});
  await fs.writeFile(executable, 'fake application executable'); await fs.chmod(executable, 0o755);
  if (process.platform === 'darwin') await fs.writeFile(path.join(app,'Contents/Info.plist'), require('plist').build({CFBundleExecutable:'Acceptance Package Test'}));
  const staging = path.join(output, 'staging'); await fs.mkdir(staging);
  for (const name of ['out','package.json','product.json']) await fs.cp(name,path.join(staging,name),{recursive:true});
  if (${sdk}) await fs.cp('node_modules/@hello-halo/agent-sdk',path.join(staging,'node_modules/@hello-halo/agent-sdk'),{recursive:true});
  ${behavior}
  await require('@electron/asar').createPackageWithOptions(staging,path.join(resources,'app.asar'),{unpackDir:'node_modules/@hello-halo/agent-sdk'});
  await fs.rm(staging,{recursive:true,force:true});
})().catch(error => { console.error(error); process.exitCode = 1; });
`)
  await buildApplication(root)
  return { root, write }
}

test('controlled directory packaging binds the executable, application output and actual unpacked SDK', async context => {
  const { root } = await fixture(context, { sdk: true })
  await assert.rejects(verifyPackagedApplication(root, 'old-app'), /No controlled acceptance package/)
  const record = await packageApplication(root)
  assert.equal((await verifyPackagedApplication(root, record.executable)).id, record.id)
  assert.equal(record.application.sdk.state, 'present')
  assert.equal(record.application.sdk.sourceRevision, null)
  assert.equal(record.application.sdk.packagedRuntime.count, 3)
  assert.equal(record.signing, process.platform === 'darwin' ? 'local-adhoc' : 'unsigned')
  assert.equal(JSON.stringify(record).includes(root), false)
  const output = path.join(root, 'tests/acceptance/output/packages', record.id)
  const invocation = JSON.parse(await fs.readFile(path.join(output, 'invocation.json'), 'utf8'))
  assert.equal(invocation.args.includes('--dir'), false)
  const platform = { darwin: '--mac', win32: '--win', linux: '--linux' }[process.platform]
  const target = { darwin: 'zip', win32: 'nsis', linux: 'AppImage' }[process.platform]
  assert.equal(invocation.args[invocation.args.indexOf(platform) + 1], target)
  assert.equal(invocation.args[invocation.args.indexOf('--publish') + 1], 'never')
  assert.equal(invocation.cscDiscovery, 'false')
  assert.equal(invocation.signingMode, 'adhoc')
  assert.equal(invocation.credentialPresent, false)
})

test('a successful builder cannot certify stale application bytes as the current build', async context => {
  const { root } = await fixture(context, { behavior: `await fs.writeFile(path.join(staging,'out/main/index.cjs'),'stale application');` })
  await assert.rejects(packageApplication(root), /differs from the controlled build: out\/main\/index.cjs/)
  await assert.rejects(verifyPackagedApplication(root, 'old-app'), /No controlled acceptance package/)
})

test('package SDK verification reads copied runtime bytes and rejects omitted workers', async context => {
  for (const behavior of [
    `await fs.writeFile(path.join(staging,'node_modules/@hello-halo/agent-sdk/dist/index.js'),'stale SDK');`,
    `await fs.rm(path.join(staging,'node_modules/@hello-halo/agent-sdk/dist/worker/entry.js'));`,
  ]) {
    const { root } = await fixture(context, { sdk: true, behavior })
    await assert.rejects(packageApplication(root), /packaged SDK runtime (?:differs|file set differs)/)
  }
})

test('an SDK source map may be excluded by the packaging configuration without hiding missing runtime code', async context => {
  const { root } = await fixture(context, { sdk: true, behavior: `await fs.rm(path.join(staging,'node_modules/@hello-halo/agent-sdk/dist/index.js.map'));` })
  const record = await packageApplication(root)
  assert.equal(record.application.sdk.packagedRuntime.count, 2)
  await verifyPackagedApplication(root, record.executable)
})

for (const [field, replacement] of [
  ['main', './dist/worker/entry.js'],
  ['module', './dist/worker/entry.js'],
  ['type', 'commonjs'],
  ['exports', { '.': './dist/worker/entry.js' }],
  ['imports', { '#worker': './dist/index.js' }],
]) test(`unchanged SDK runtime bytes cannot hide a changed ${field} resolution field`, async context => {
  const behavior = `const manifestFile=path.join(staging,'node_modules/@hello-halo/agent-sdk/package.json');const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));manifest[${JSON.stringify(field)}]=${JSON.stringify(replacement)};await fs.writeFile(manifestFile,JSON.stringify(manifest));`
  const { root, write } = await fixture(context, { sdk: true, behavior })
  await write('node_modules/@hello-halo/agent-sdk/package.json', JSON.stringify({
    name: '@hello-halo/agent-sdk', version: '1.0.0', main: './dist/index.js',
    module: './dist/index.js', type: 'module', exports: { '.': './dist/index.js' },
    imports: { '#worker': './dist/worker/entry.js' },
  }))
  await buildApplication(root)
  await assert.rejects(packageApplication(root), new RegExp(`runtime resolution differs from the controlled dependency: ${field}`))
  await assert.rejects(verifyPackagedApplication(root, 'old-app'), /No controlled acceptance package/)
})

test('packaging may remove SDK development metadata without changing runtime resolution', async context => {
  const behavior = `const manifestFile=path.join(staging,'node_modules/@hello-halo/agent-sdk/package.json');const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));for(const field of ['scripts','devDependencies','types'])delete manifest[field];await fs.writeFile(manifestFile,JSON.stringify(manifest));`
  const { root, write } = await fixture(context, { sdk: true, behavior })
  await write('node_modules/@hello-halo/agent-sdk/package.json', JSON.stringify({
    name: '@hello-halo/agent-sdk', version: '1.0.0', main: './dist/index.js',
    type: 'module', exports: { '.': './dist/index.js' }, types: './dist/index.d.ts',
    scripts: { build: 'test-only-build' }, devDependencies: { 'test-only-compiler': '1.0.0' },
  }))
  await buildApplication(root)
  const record = await packageApplication(root)
  await verifyPackagedApplication(root, record.executable)
})

test('a different executable, modified executable, archive or unpacked SDK cannot reuse package evidence', async context => {
  const { root, write } = await fixture(context, { sdk: true })
  const record = await packageApplication(root)
  await write('other-executable', 'fake application executable')
  await assert.rejects(verifyPackagedApplication(root, 'other-executable'), /not the controlled acceptance package/)
  for (const name of [record.executable, record.resources + '/app.asar', record.resources + '/app.asar.unpacked/node_modules/@hello-halo/agent-sdk/dist/index.js']) {
    const original = await fs.readFile(path.join(root, name))
    await write(name, 'tampered output')
    await assert.rejects(verifyPackagedApplication(root, record.executable), /content changed/)
    await write(name, original)
  }
  await verifyPackagedApplication(root, record.executable)
})

test('packaging hooks and a new build identity invalidate an otherwise unchanged package', async context => {
  const { root, write } = await fixture(context)
  const record = await packageApplication(root)
  await write('scripts/afterPack.cjs', 'module.exports = () => { return 1 }\n')
  await assert.rejects(verifyPackagedApplication(root, record.executable), /Packaging inputs changed/)
  await write('scripts/afterPack.cjs', 'module.exports = () => {}\n')
  await buildApplication(root)
  await assert.rejects(verifyPackagedApplication(root, record.executable), /different controlled build/)
})

test('installed production dependency changes invalidate the package even when its version is unchanged', async context => {
  const { root, write } = await fixture(context)
  const record = await packageApplication(root)
  await write('node_modules/test-runtime/index.js', 'module.exports = 2\n')
  await assert.rejects(verifyPackagedApplication(root, record.executable), /Packaging inputs changed/)
})

test('cross-package dependency links are valid only while their captured target remains unchanged', async context => {
  const { root, write } = await fixture(context)
  await write('node_modules/test-runtime/package.json', JSON.stringify({ name: 'test-runtime', version: '1.0.0', dependencies: { 'test-cli': '1.0.0' } }))
  await write('node_modules/test-cli/package.json', JSON.stringify({ name: 'test-cli', version: '1.0.0' }))
  await write('node_modules/test-cli/cli.js', 'process.stdout.write("ready")\n')
  await fs.symlink('../test-cli/cli.js', path.join(root, 'node_modules/test-runtime/cli.js'))
  const record = await packageApplication(root)
  await verifyPackagedApplication(root, record.executable)
  await write('node_modules/test-cli/cli.js', 'process.stdout.write("changed")\n')
  await assert.rejects(verifyPackagedApplication(root, record.executable), /Packaging inputs changed/)
})

test('an installed dependency cannot link to an uncaptured adjacent directory', async context => {
  const { root, write } = await fixture(context)
  await write('node_modules/uncaptured/cli.js', 'not a declared dependency')
  await fs.symlink('../uncaptured/cli.js', path.join(root, 'node_modules/test-runtime/cli.js'))
  await assert.rejects(packageApplication(root), /link leaves its captured components/)
})

test('an installed dependency cannot hide a link target in excluded package metadata', async context => {
  const { root, write } = await fixture(context)
  await write('node_modules/test-runtime/.git/untracked.js', 'uncaptured bytes')
  await fs.symlink('.git/untracked.js', path.join(root, 'node_modules/test-runtime/cli.js'))
  await assert.rejects(packageApplication(root), /must resolve to captured content/)
})

test('framework-style directory links preserve captured byte identity', async context => {
  const { root, write } = await fixture(context)
  await write('node_modules/test-runtime/versions/one/runtime.js', 'captured runtime')
  await fs.symlink('one', path.join(root, 'node_modules/test-runtime/versions/current'))
  await fs.symlink('versions/current', path.join(root, 'node_modules/test-runtime/runtime'))
  const record = await packageApplication(root)
  await verifyPackagedApplication(root, record.executable)
  await write('node_modules/test-runtime/versions/one/runtime.js', 'modified runtime')
  await assert.rejects(verifyPackagedApplication(root, record.executable), /Packaging inputs changed/)
})

test('a failed builder or source mutation during packaging leaves no package stamp', async context => {
  for (const behavior of ['process.exit(7);', `await fs.writeFile('src/main.ts','changed while packaging');`]) {
    const { root } = await fixture(context, { behavior })
    await assert.rejects(packageApplication(root), /did not complete successfully|Product inputs changed/)
    await assert.rejects(verifyPackagedApplication(root, 'old-app'), /No controlled acceptance package/)
  }
})

test('a package symlink cannot hide content outside the captured application', async context => {
  const { root } = await fixture(context, { behavior: `await fs.symlink(path.resolve('src/main.ts'),path.join(resources,'outside'));` })
  await assert.rejects(packageApplication(root), /link leaves its captured components/)
})
