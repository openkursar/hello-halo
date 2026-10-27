import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildApplication, verifyBuild } from '../../../scripts/acceptance/lib/build.mjs'

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-build-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const write = async (name, value) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value) }
  await write('.gitignore', 'out/\nnode_modules/\ntests/acceptance/output/\n')
  await write('package.json', JSON.stringify({ name: 'acceptance-build-test', version: '1.0.0', main: './out/main/index.cjs', scripts: { build: 'node build.cjs' } }))
  await write('package-lock.json', '{}')
  await write('product.json', JSON.stringify({ authProviders: [{ path: './providers/auth.mjs' }] }))
  await write('src/main.ts', 'export const answer = 1\n')
  const build = `const fs=require('node:fs');for(const part of ['main','preload','renderer'])fs.mkdirSync('out/'+part,{recursive:true});fs.writeFileSync('out/main/index.cjs',fs.readFileSync('src/main.ts'));fs.writeFileSync('out/preload/index.cjs','preload');fs.writeFileSync('out/renderer/index.html','<main>ready</main>');`
  await write('build.cjs', build)
  return { root, write, build }
}

test('a real controlled build binds current product inputs while allowing test and documentation edits', async context => {
  const { root, write } = await fixture(context)
  await assert.rejects(verifyBuild(root), /No controlled acceptance build/)
  const record = await buildApplication(root)
  assert.equal(record.sdk.state, 'absent')
  assert.equal((await verifyBuild(root)).id, record.id)
  await write('tests/new.test.mjs', 'test only')
  await write('docs/guide.md', 'documentation only')
  await write('src/DESIGN.md', 'architecture explanation only')
  assert.equal((await verifyBuild(root)).id, record.id)
})

test('changed product code, build tooling and every output component invalidate provenance', async context => {
  const { root, write, build } = await fixture(context)
  await buildApplication(root)
  await write('src/main.ts', 'export const answer = 2\n')
  await assert.rejects(verifyBuild(root), /Product inputs changed/)
  await buildApplication(root)
  await write('build.cjs', build + '\n// changed builder\n')
  await assert.rejects(verifyBuild(root), /Product inputs changed/)
  await buildApplication(root)
  for (const file of ['out/main/index.cjs', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    const original = await fs.readFile(path.join(root, file))
    await write(file, 'different output')
    await assert.rejects(verifyBuild(root), /build output changed/)
    await write(file, original)
  }
})

test('the Electron fixture can rewrite identical product configuration without invalidating the build', async context => {
  const { root, write } = await fixture(context)
  await buildApplication(root)
  const product = JSON.parse(await fs.readFile(path.join(root, 'out/main/product.json'), 'utf8'))
  assert.equal(product.authProviders[0].path, path.relative(path.join(root, 'out/main'), path.join(root, 'providers/auth.mjs')))
  await write('out/main/product.json', JSON.stringify(product, null, 2))
  await verifyBuild(root)
  product.authProviders[0].path = 'unexpected-provider.mjs'
  await write('out/main/product.json', JSON.stringify(product, null, 2))
  await assert.rejects(verifyBuild(root), /build output changed/)
})

test('failed builds and source changes during compilation leave no valid stamp', async context => {
  const { root, write, build } = await fixture(context)
  await buildApplication(root)
  await write('build.cjs', 'process.exit(1)')
  await assert.rejects(buildApplication(root), /did not complete successfully/)
  await assert.rejects(verifyBuild(root), /No controlled acceptance build/)
  await write('build.cjs', build + "fs.appendFileSync('src/main.ts','// changed during compilation');")
  await assert.rejects(buildApplication(root), /changed during the build/)
  await assert.rejects(verifyBuild(root), /No controlled acceptance build/)
})

test('SDK source and compiled distribution are separate identities even without a private Git checkout', async context => {
  const { root, write } = await fixture(context)
  await write('node_modules/@hello-halo/agent-sdk/package.json', JSON.stringify({ name: '@hello-halo/agent-sdk', version: '1.0.0' }))
  await write('node_modules/@hello-halo/agent-sdk/src/index.ts', 'source')
  await write('node_modules/@hello-halo/agent-sdk/dist/index.js', 'compiled')
  const record = await buildApplication(root)
  assert.equal(record.sdk.state, 'present')
  assert.equal(record.sdk.revision, null)
  assert.equal(record.sdk.dirty, null)
  assert.equal(record.sdk.provenance, 'distribution-without-revision')
  await write('node_modules/@hello-halo/agent-sdk/dist/index.js', 'changed compiled')
  await assert.rejects(verifyBuild(root), /SDK source, revision or compiled/)
  await write('node_modules/@hello-halo/agent-sdk/dist/index.js', 'compiled')
  await write('node_modules/@hello-halo/agent-sdk/src/index.ts', 'changed source')
  await assert.rejects(verifyBuild(root), /SDK source, revision or compiled/)
})

test('build tooling follows actual imports without parsing generated program strings as dependencies', async context => {
  const { root, write, build } = await fixture(context)
  await write('build.cjs', build + '\nconst generated = "import value from \'./generated-only.mjs\'";\n')
  await buildApplication(root)
  await verifyBuild(root)
  await write('build.cjs', build + '\nrequire("./real-missing.cjs");\n')
  await assert.rejects(buildApplication(root), /Build dependency is missing for build.cjs/)
})

test('a successful no-op build cannot attest stale outputs or generated resources', async context => {
  const { root, write } = await fixture(context)
  await buildApplication(root)
  await write('resources/dsh-runtime/index.cjs', 'stale optional runtime')
  await write('build.cjs', 'process.exit(0)')
  await assert.rejects(buildApplication(root), /main output directory is missing/)
  await assert.rejects(verifyBuild(root), /No controlled acceptance build/)
  await assert.rejects(fs.access(path.join(root, 'out/renderer/index.html')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(root, 'resources/dsh-runtime/index.cjs')), { code: 'ENOENT' })
})

test('controlled builds reject concurrent writers without deleting their outputs', async context => {
  const { root, write, build } = await fixture(context)
  await write('build.cjs', `const fs = require('node:fs');fs.writeFileSync('started','ready');const timer=setInterval(()=>{if(!fs.existsSync('continue'))return;clearInterval(timer);${build.replace("const fs=require('node:fs');", '')}},10);setTimeout(()=>process.exit(1),10000).unref();`)
  const first = buildApplication(root)
  let record
  try {
    let started = false
    for (let attempt = 0; attempt < 500; attempt++) {
      try { await fs.access(path.join(root, 'started')); started = true; break } catch (error) { if (error.code !== 'ENOENT') throw error }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(started, true, 'the first real builder must have started')
    await assert.rejects(buildApplication(root), /controlled build already owns/)
    await assert.rejects(verifyBuild(root), /still in progress/)
  } finally {
    await write('continue', 'release the owned builder')
    record = await first
  }
  assert.equal((await verifyBuild(root)).id, record.id)
  await assert.rejects(fs.access(path.join(root, 'out/.acceptance-build.lock')), { code: 'ENOENT' })
})

test('build cleanup refuses a symbolic output parent instead of touching another directory', async context => {
  const { root, write } = await fixture(context)
  await write('elsewhere/main/keep.txt', 'must survive')
  await fs.symlink(path.join(root, 'elsewhere'), path.join(root, 'out'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(buildApplication(root), /must not be a symbolic link/)
  assert.equal(await fs.readFile(path.join(root, 'elsewhere/main/keep.txt'), 'utf8'), 'must survive')
})

test('provenance from a builder without a clean-output guarantee cannot be reused', async context => {
  const { root, write } = await fixture(context)
  const record = await buildApplication(root)
  await write('out/.acceptance-build.json', JSON.stringify({ ...record, version: 1 }))
  await assert.rejects(verifyBuild(root), /rebuild from clean outputs/)
})

async function useProductSelection(context, write) {
  const previous = process.env.HALO_PRODUCT_SOURCE
  delete process.env.HALO_PRODUCT_SOURCE
  context.after(() => {
    if (previous === undefined) delete process.env.HALO_PRODUCT_SOURCE
    else process.env.HALO_PRODUCT_SOURCE = previous
  })
  await write('scripts/product-source.mjs', await fs.readFile(fileURLToPath(new URL('../../../scripts/product-source.mjs', import.meta.url))))
}

test('a vanilla checkout materializes its own default product before capturing build inputs', async context => {
  const { root, write } = await fixture(context)
  await useProductSelection(context, write)
  await fs.rm(path.join(root, 'product.json'))
  const product = JSON.stringify({ name: 'Default fixture product', authProviders: [] }, null, 2) + '\n'
  await write('product.example.json', product)
  const record = await buildApplication(root)
  assert.equal(await fs.readFile(path.join(root, 'product.json'), 'utf8'), product)
  assert.equal((await verifyBuild(root)).id, record.id)
  assert(record.inputs.files.some(file => file.path === 'product.json'))
})

test('default product preparation preserves existing local configuration byte for byte', async context => {
  const { root, write } = await fixture(context)
  await useProductSelection(context, write)
  const product = '{\n  "name": "Existing fixture product",\n  "authProviders": []\n}\n'
  await write('product.json', product)
  await write('product.example.json', JSON.stringify({ name: 'Unselected default', authProviders: [] }))
  await buildApplication(root)
  assert.equal(await fs.readFile(path.join(root, 'product.json'), 'utf8'), product)
})

test('an explicitly selected variant is synchronized before the snapshot and remains stable through prebuild', async context => {
  const { root, write, build } = await fixture(context)
  await useProductSelection(context, write)
  const variant = JSON.stringify({ name: 'Selected fixture product', dataFolderName: '.fixture-selected', authProviders: [] }, null, 2) + '\n'
  await write('halo-local/product.fixture.json', variant)
  await write('.product-source', 'halo-local/product.fixture.json\n')
  await write('product.example.json', JSON.stringify({ name: 'Unselected default', authProviders: [] }))
  await write('prebuild.mjs', "import { syncProductJson } from './scripts/product-source.mjs';await syncProductJson({interactive:false});")
  const descriptor = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  descriptor.scripts.prebuild = 'node prebuild.mjs'
  await write('package.json', JSON.stringify(descriptor))
  await write('build.cjs', build + `if(JSON.parse(fs.readFileSync('product.json','utf8')).name!=='Selected fixture product')process.exit(9);`)
  const record = await buildApplication(root)
  assert.equal(await fs.readFile(path.join(root, 'product.json'), 'utf8'), variant)
  assert.equal((await verifyBuild(root)).id, record.id)
})

test('missing product configuration fails explicitly and leaves neither a stamp nor a build lock', async context => {
  const { root, write } = await fixture(context)
  await useProductSelection(context, write)
  await buildApplication(root)
  await fs.rm(path.join(root, 'product.json'))
  await assert.rejects(buildApplication(root), /No product configuration is available/)
  await assert.rejects(verifyBuild(root), /No controlled acceptance build/)
  await assert.rejects(fs.access(path.join(root, 'out/.acceptance-build.lock')), { code: 'ENOENT' })
})
