import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { buildApplication } from '../../../scripts/acceptance/lib/build.mjs'

const require = createRequire(import.meta.url)
const moduleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-package-module-'))
after(() => fs.rm(moduleDirectory, { recursive: true, force: true }))
const packageModule = fileURLToPath(new URL('../../../scripts/acceptance/lib/package.mjs', import.meta.url))
const processModule = fileURLToPath(new URL('../../../scripts/acceptance/lib/process.mjs', import.meta.url))
const compiledModule = path.join(moduleDirectory, 'package.mjs')
await build({ entryPoints: [packageModule], outfile: compiledModule, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: [processModule], plugins: [{ name: 'synthetic-electron-probe', setup(build) {
  build.onResolve({ filter: /^\./ }, args => {
    if (args.importer !== packageModule) return
    if (args.path === './process.mjs') return { path: args.path, namespace: 'synthetic-runtime' }
    return { path: path.resolve(path.dirname(packageModule), args.path), external: true }
  })
  build.onLoad({ filter: /.*/, namespace: 'synthetic-runtime' }, () => ({ loader: 'js', contents: `
    import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {Script} from 'node:vm';import {execute as realExecute} from ${JSON.stringify(processModule)};
    export async function execute(root,args,options){
      if(!options.executable)return realExecute(root,args,options);
      assert.equal(options.environment.ELECTRON_RUN_AS_NODE,'1');assert.equal(options.environment.NODE_OPTIONS,undefined);assert.equal(options.environment.NODE_PATH,undefined);
      assert(args[1].includes('process.versions.electron'));
      new Script(args[1]);
      const probe=JSON.parse(await fs.readFile(path.join(root,'node_modules/electron/dist/probe.json'),'utf8'));
      const log=probe.log??'ACCEPTANCE_ELECTRON_RUNTIME='+JSON.stringify(probe.identity)+'\\n';
      await fs.writeFile(options.logFile,log);
      return {code:probe.code??0,timedOut:probe.timedOut??false,cleanupFailed:probe.cleanupFailed??false,log};
    }
  ` }))
} }] })
const { packageApplication, verifyPackagedApplication } = await import(pathToFileURL(compiledModule).href)

const electronVersion = '1.2.3'
const electronEntry = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron'
const stockApplication = process.platform === 'darwin' ? 'Electron.app/Contents/Resources/default_app.asar' : 'resources/default_app.asar'

async function fixture(context, { sdk = false, behavior = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-package-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const write = async (name, value) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value) }
  await write('.gitignore', 'out/\nnode_modules/\ntests/acceptance/output/\n')
  await write('package.json', JSON.stringify({ name: 'acceptance-package-test', version: '1.0.0', main: './out/main/index.cjs', scripts: { build: 'node build.cjs' }, devDependencies: { electron: electronVersion }, dependencies: { 'test-runtime': '1.0.0' }, optionalDependencies: sdk ? { '@hello-halo/agent-sdk': '1.0.0' } : {} }))
  await write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { devDependencies: { electron: electronVersion } }, 'node_modules/electron': { version: electronVersion } } }))
  await write('product.json', JSON.stringify({ name: 'Acceptance Package Test', appId: 'example.test', authProviders: [] }))
  await write('src/main.ts', 'export const answer = 1\n')
  await write('electron-builder.cjs', 'module.exports = { beforePack: "./scripts/beforePack.cjs", afterPack: "./scripts/afterPack.cjs" }\n')
  await write('scripts/beforePack.cjs', 'module.exports = context => require("node:fs").writeFileSync(require("node:path").join(context.outDir,"before-hook.txt"),"before")\n')
  await write('scripts/afterPack.cjs', 'module.exports = context => require("node:fs").writeFileSync(require("node:path").join(context.outDir,"after-hook.txt"),"after")\n')
  await write('node_modules/test-runtime/package.json', JSON.stringify({ name: 'test-runtime', version: '1.0.0' }))
  await write('node_modules/test-runtime/index.js', 'module.exports = 1\n')
  await write('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: electronVersion }))
  await write('node_modules/electron/path.txt', electronEntry)
  await write('node_modules/electron/dist/version', electronVersion)
  await write('node_modules/electron/dist/' + electronEntry, 'synthetic locked Electron executable')
  await fs.chmod(path.join(root, 'node_modules/electron/dist', electronEntry), 0o755)
  await write('node_modules/electron/dist/' + stockApplication, 'stock default application')
  await write('node_modules/electron/dist/LICENSE', 'synthetic runtime license')
  await write('node_modules/electron/dist/probe.json', JSON.stringify({ identity: { electron: electronVersion, node: '22.0.0', platform: process.platform, arch: process.arch } }))
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
  const electronDist = args.find(value => value.startsWith('-c.electronDist=')).slice('-c.electronDist='.length);
  const electronVersion = args.find(value => value.startsWith('-c.electronVersion=')).slice('-c.electronVersion='.length);
  if(electronVersion!==${JSON.stringify(electronVersion)})throw new Error('Unexpected runtime version');
  for(const name of ['version',${JSON.stringify(stockApplication)}])if(await fs.stat(path.join(electronDist,name)).then(()=>true,()=>false))throw new Error('Stock runtime content was not normalized in the owned staging copy');
  const config=require(path.resolve('electron-builder.cjs'));
  await require(path.resolve(config.beforePack))({outDir:output});
  await fs.writeFile(path.join(output, 'invocation.json'), JSON.stringify({args, signingMode:process.env.HALO_MAC_SIGN_MODE, cscDiscovery:process.env.CSC_IDENTITY_AUTO_DISCOVERY, credentialPresent:Boolean(process.env.CSC_LINK || process.env.APPLE_ID || process.env.GITHUB_TOKEN), nodeOptionsPresent:Boolean(process.env.NODE_OPTIONS), nodePathPresent:Boolean(process.env.NODE_PATH)}));
  const app = path.join(output, process.platform === 'darwin' ? 'mac-test/Acceptance Package Test.app' : 'test-unpacked');
  const resources = path.join(app, process.platform === 'darwin' ? 'Contents/Resources' : 'resources');
  const executable = path.join(app, process.platform === 'darwin' ? 'Contents/MacOS/Acceptance Package Test' : process.platform === 'win32' ? 'Acceptance Package Test.exe' : 'acceptance-package-test');
  await fs.cp(path.join(electronDist,process.platform==='darwin'?'Electron.app':''),app,{recursive:true,verbatimSymlinks:true});
  await fs.mkdir(resources, {recursive:true}); await fs.mkdir(path.dirname(executable), {recursive:true});
  await fs.writeFile(executable, 'fake application executable'); await fs.chmod(executable, 0o755);
  if (process.platform === 'darwin') await fs.writeFile(path.join(app,'Contents/Info.plist'), require('plist').build({CFBundleExecutable:'Acceptance Package Test'}));
  const staging = path.join(output, 'staging'); await fs.mkdir(staging);
  for (const name of ['out','package.json','product.json']) await fs.cp(name,path.join(staging,name),{recursive:true});
  if (${sdk}) await fs.cp('node_modules/@hello-halo/agent-sdk',path.join(staging,'node_modules/@hello-halo/agent-sdk'),{recursive:true});
  ${behavior}
  await require('@electron/asar').createPackageWithOptions(staging,path.join(resources,'app.asar'),{unpackDir:'node_modules/@hello-halo/agent-sdk'});
  await require(path.resolve(config.afterPack))({outDir:output});
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
  assert.equal(invocation.nodeOptionsPresent, false)
  assert.equal(invocation.nodePathPresent, false)
  assert.equal(record.version, 2)
  assert.equal(record.inputs.electron.version, electronVersion)
  assert.deepEqual(record.electronRuntime, { electron: electronVersion, node: '22.0.0', platform: process.platform, arch: process.arch })
  assert.equal(invocation.args[invocation.args.indexOf('--config') + 1], 'electron-builder.cjs')
  const staged = invocation.args.find(value => value.startsWith('-c.electronDist=')).slice('-c.electronDist='.length)
  assert(staged.startsWith(`tests/acceptance/output/packages/${record.id}/.electron-input-`))
  assert.equal(await fs.stat(path.join(root, staged)).then(() => true, () => false), false)
  assert.equal(await fs.readFile(path.join(root, 'node_modules/electron/dist/version'), 'utf8'), electronVersion)
  assert.equal(await fs.readFile(path.join(root, 'node_modules/electron/dist', stockApplication), 'utf8'), 'stock default application')
  assert.equal(await fs.readFile(path.join(output, 'before-hook.txt'), 'utf8'), 'before')
  assert.equal(await fs.readFile(path.join(output, 'after-hook.txt'), 'utf8'), 'after')
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
    for (const output of await fs.readdir(path.join(root, 'tests/acceptance/output/packages'))) assert.equal((await fs.readdir(path.join(root, 'tests/acceptance/output/packages', output))).some(name => name.startsWith('.electron-input-')), false)
  }
})

test('a package symlink cannot hide content outside the captured application', async context => {
  const { root } = await fixture(context, { behavior: `await fs.symlink(path.resolve('src/main.ts'),path.join(resources,'outside'));` })
  await assert.rejects(packageApplication(root), /link leaves its captured components/)
})

for (const source of ['declaration', 'lock-declaration', 'lock-package', 'installed-package', 'distribution-version']) {
  test(`controlled packaging rejects a mismatched Electron ${source}`, async context => {
    const { root, write } = await fixture(context)
    const read = name => fs.readFile(path.join(root, name), 'utf8').then(JSON.parse)
    if (source === 'declaration') {
      const pkg = await read('package.json'); pkg.devDependencies.electron = '^' + electronVersion
      await write('package.json', JSON.stringify(pkg))
    } else if (source.startsWith('lock-')) {
      const lock = await read('package-lock.json')
      if (source === 'lock-declaration') lock.packages[''].devDependencies.electron = '9.9.9'
      else lock.packages['node_modules/electron'].version = '9.9.9'
      await write('package-lock.json', JSON.stringify(lock))
    } else if (source === 'installed-package') await write('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '9.9.9' }))
    else await write('node_modules/electron/dist/version', '9.9.9')
    await buildApplication(root)
    await assert.rejects(packageApplication(root), /Electron.*(?:version|lock)/)
    await assert.rejects(verifyPackagedApplication(root, 'old-app'), /No controlled acceptance package/)
  })
}

for (const difference of [{ electron: '9.9.9' }, { arch: 'wrong-architecture' }, { platform: 'wrong-platform' }]) {
  test(`metadata cannot hide a different actual Electron ${Object.keys(difference)[0]}`, async context => {
    const { root, write } = await fixture(context)
    await write('node_modules/electron/dist/probe.json', JSON.stringify({ identity: { electron: electronVersion, node: '22.0.0', platform: process.platform, arch: process.arch, ...difference } }))
    await assert.rejects(packageApplication(root), /actual Electron runtime version, platform or architecture/)
    await assert.rejects(verifyPackagedApplication(root, 'old-app'), /No controlled acceptance package/)
  })
}

test('missing, ambiguous or failed runtime probes cannot fall back to a download or successful builder', async context => {
  for (const probe of [{ log: '' }, { log: 'ACCEPTANCE_ELECTRON_RUNTIME={}\nACCEPTANCE_ELECTRON_RUNTIME={}\n' }, { code: 7 }, { timedOut: true }, { cleanupFailed: true }]) {
    const { root, write } = await fixture(context)
    await write('node_modules/electron/dist/probe.json', JSON.stringify({ identity: { electron: electronVersion, node: '22.0.0', platform: process.platform, arch: process.arch }, ...probe }))
    await assert.rejects(packageApplication(root), /identity probe|unambiguous identity/)
    for (const output of await fs.readdir(path.join(root, 'tests/acceptance/output/packages'))) assert.equal(await fs.stat(path.join(root, 'tests/acceptance/output/packages', output, 'invocation.json')).then(() => true, () => false), false)
  }
})

test('an inherited Electron override is refused without exposing its value', async context => {
  const { root } = await fixture(context)
  const previous = process.env.ELECTRON_OVERRIDE_DIST_PATH
  process.env.ELECTRON_OVERRIDE_DIST_PATH = path.join(root, 'untrusted-host-runtime')
  try { await assert.rejects(packageApplication(root), error => /refuses ELECTRON_OVERRIDE_DIST_PATH/.test(error.message) && !error.message.includes(root)) }
  finally { if (previous === undefined) delete process.env.ELECTRON_OVERRIDE_DIST_PATH; else process.env.ELECTRON_OVERRIDE_DIST_PATH = previous }
})

test('a missing distribution or escaping runtime link is rejected before packaging', async context => {
  for (const missing of [true, false]) {
    const { root, write } = await fixture(context)
    if (missing) await fs.rm(path.join(root, 'node_modules/electron/dist'), { recursive: true })
    else {
      await write('outside-runtime', 'uncaptured runtime bytes')
      await fs.symlink(path.join(root, 'outside-runtime'), path.join(root, 'node_modules/electron/dist/outside'))
    }
    await assert.rejects(packageApplication(root), /ENOENT|link leaves its captured components/)
    await assert.rejects(verifyPackagedApplication(root, 'old-app'), /No controlled acceptance package/)
  }
})

test('source and staged runtime mutations during the builder leave no reusable package stamp', async context => {
  for (const staged of [false, true]) {
    const filename = staged ? `path.join(electronDist,${JSON.stringify(electronEntry)})` : JSON.stringify('node_modules/electron/dist/' + electronEntry)
    const { root } = await fixture(context, { behavior: `await fs.writeFile(${filename},'changed runtime');` })
    await assert.rejects(packageApplication(root), /staged Electron runtime changed|packaging inputs changed/i)
    await assert.rejects(verifyPackagedApplication(root, 'old-app'), /No controlled acceptance package/)
    if (staged) assert.equal(await fs.readFile(path.join(root, 'node_modules/electron/dist', electronEntry), 'utf8'), 'synthetic locked Electron executable')
  }
})

test('verification rejects unchanged-version runtime tampering and stamps without runtime provenance', async context => {
  const { root, write } = await fixture(context)
  const record = await packageApplication(root)
  await write('node_modules/electron/dist/LICENSE', 'changed runtime content')
  await assert.rejects(verifyPackagedApplication(root, record.executable), /Packaging inputs changed/)
  await write('node_modules/electron/dist/LICENSE', 'synthetic runtime license')
  await verifyPackagedApplication(root, record.executable)
  await write('out/.acceptance-package.json', JSON.stringify({ ...record, version: 1 }))
  await assert.rejects(verifyPackagedApplication(root, record.executable), /fresh controlled package/)
})

test('framework-style runtime links survive the isolated copy and remain part of package verification', async context => {
  const { root, write } = await fixture(context)
  const framework = process.platform === 'darwin' ? 'Electron.app/Contents/Frameworks/Synthetic.framework' : 'framework'
  const base = 'node_modules/electron/dist/' + framework
  await write(base + '/Versions/A/runtime', 'captured native runtime')
  await fs.symlink('A', path.join(root, base, 'Versions/Current'))
  await fs.symlink('Versions/Current/runtime', path.join(root, base, 'runtime'))
  const record = await packageApplication(root)
  assert.equal(await fs.readlink(path.join(root, base, 'Versions/Current')), 'A')
  await verifyPackagedApplication(root, record.executable)
  await write(base + '/Versions/A/runtime', 'changed native runtime')
  await assert.rejects(verifyPackagedApplication(root, record.executable), /Packaging inputs changed/)
})

test('a runtime link cannot reach package metadata outside its distribution', async context => {
  const { root, write } = await fixture(context)
  await write('node_modules/electron/uncaptured-native-file', 'outside the distribution')
  await fs.symlink('../uncaptured-native-file', path.join(root, 'node_modules/electron/dist/native-link'))
  await assert.rejects(packageApplication(root), /link leaves its captured components/)
  assert.equal(await fs.readFile(path.join(root, 'node_modules/electron/dist/version'), 'utf8'), electronVersion)
})

test('a default-name Electron zip cannot shadow the verified unpacked runtime', async context => {
  const { root, write } = await fixture(context)
  await write(`node_modules/electron/dist/electron-v${electronVersion}-${process.platform}-${process.arch}.zip`, 'different archived runtime')
  await assert.rejects(packageApplication(root), /archive that would override the verified unpacked runtime/)
  await assert.rejects(verifyPackagedApplication(root, 'old-app'), /No controlled acceptance package/)
  assert.equal(await fs.stat(path.join(root, 'tests/acceptance/output/packages')).then(() => true, () => false), false)
})

test('external Node preload and module paths do not enter the real builder process', async context => {
  const { root, write } = await fixture(context)
  const marker = path.join(root, 'external-preload-ran')
  await write('external-preload.cjs', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'uncaptured execution')`)
  const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH }
  process.env.NODE_OPTIONS = '--require ' + JSON.stringify(path.join(root, 'external-preload.cjs'))
  process.env.NODE_PATH = path.join(root, 'uncaptured-modules')
  try {
    const record = await packageApplication(root)
    const invocation = JSON.parse(await fs.readFile(path.join(root, 'tests/acceptance/output/packages', record.id, 'invocation.json'), 'utf8'))
    assert.equal(invocation.nodeOptionsPresent, false)
    assert.equal(invocation.nodePathPresent, false)
    assert.equal(await fs.stat(marker).then(() => true, () => false), false)
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  }
})
