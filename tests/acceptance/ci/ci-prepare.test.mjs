import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'
import { prepareDependencies } from '../../../scripts/acceptance/ci-prepare.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const linkDirectory = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')

function workspace(context) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-prepare-')))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
  return { root, write, sdk: path.join(root, 'src/sdk/halo-sdk'), link: path.join(root, 'node_modules/@hello-halo/agent-sdk') }
}

function checkout(context, options = {}) {
  const fixture = workspace(context)
  const { root, sdk, write } = fixture
  const descriptor = { name: '@hello-halo/agent-sdk', version: '1.0.0', main: './dist/index.js', exports: { '.': './dist/index.js', './worker': { import: './dist/worker/index.js' } }, scripts: { build: 'node build.cjs' } }
  write('src/sdk/halo-sdk/package.json', JSON.stringify(descriptor))
  write('src/sdk/halo-sdk/package-lock.json', JSON.stringify({ name: descriptor.name, version: descriptor.version, lockfileVersion: 3, packages: { '': { name: descriptor.name, version: descriptor.version } } }))
  write('src/sdk/halo-sdk/.gitignore', 'node_modules/\ndist/\n')
  write('src/sdk/halo-sdk/build.cjs', `const fs=require('node:fs'); fs.mkdirSync('dist/worker',{recursive:true}); fs.writeFileSync('dist/index.js','compiled'); fs.writeFileSync('dist/worker/index.js','worker');`)
  const git = args => execFileSync('git', args, { cwd: sdk, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Acceptance test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Acceptance test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git(['init', '--quiet'])
  git(['add', '.'])
  const tree = git(['write-tree'])
  const revision = git(['commit-tree', tree, '-m', 'Isolated dependency fixture'])
  git(['update-ref', 'HEAD', revision])
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  if (options.built) {
    write('src/sdk/halo-sdk/dist/index.js', 'compiled')
    write('src/sdk/halo-sdk/dist/worker/index.js', 'worker')
  }
  return { ...fixture, revision, environment: { ...process.env, HALO_SDK_REVISION: revision }, git }
}

test('public installation removes only its newly generated dependency-only SDK placeholder before native preparation', context => {
  const { root, write, sdk, link } = workspace(context)
  const calls = []
  const result = prepareDependencies(root, 'install', { run(command, args, cwd, environment) {
    calls.push(args)
    assert.equal(cwd, root)
    if (args[0] === 'ci') {
      assert(args.includes('--ignore-scripts'))
      write('src/sdk/halo-sdk/node_modules/@types/node/index.d.ts', 'declare const fixture: string')
      write('src/sdk/halo-sdk/node_modules/undici-types/index.d.ts', 'declare const fixture: string')
      fs.mkdirSync(path.dirname(link), { recursive: true })
      linkDirectory(sdk, link)
    } else if (command === process.execPath) {
      assert.equal(command, process.execPath)
      assert.equal(args[0], 'scripts/postinstall.mjs')
      assert.equal(fs.existsSync(sdk), false)
      assert.equal(fs.existsSync(link), false)
      assert(environment.PATH.startsWith(path.join(root, 'node_modules/.bin')))
    } else {
      assert.deepEqual(args, ['run', 'prepare'])
      assert.equal(fs.existsSync(sdk), false)
    }
  } })
  assert.deepEqual(result, { command: 'install', sdk: 'absent' })
  assert.equal(calls.length, 3)
  assert.equal(fs.existsSync(sdk), false)
})

test('real offline npm ci can install the public lock before a required local SDK checkout exists', context => {
  const { root, write, sdk, link } = workspace(context)
  const descriptor = { name: 'acceptance-public-install', version: '1.0.0', scripts: { prepare: 'node scripts/prepare.mjs' }, dependencies: { '@hello-halo/agent-sdk': 'file:src/sdk/halo-sdk' } }
  write('package.json', JSON.stringify(descriptor))
  write('package-lock.json', JSON.stringify({ name: descriptor.name, version: descriptor.version, lockfileVersion: 3, requires: true, packages: {
    '': descriptor,
    'node_modules/@hello-halo/agent-sdk': { resolved: 'src/sdk/halo-sdk', link: true },
    'src/sdk/halo-sdk': { name: '@hello-halo/agent-sdk', version: '1.0.0' },
  } }))
  write('scripts/postinstall.mjs', `import fs from 'node:fs'; if(fs.existsSync('src/sdk/halo-sdk') || fs.existsSync('node_modules/@hello-halo/agent-sdk')) throw new Error('SDK must remain absent during public preparation'); fs.writeFileSync('native-preparation.txt','complete');`)
  write('scripts/prepare.mjs', `import fs from 'node:fs'; if(!fs.existsSync('native-preparation.txt')) throw new Error('Native preparation must run first'); fs.writeFileSync('host-binaries.txt','complete');`)
  prepareDependencies(root, 'install', { environment: { ...process.env, npm_config_offline: 'true' } })
  assert.equal(fs.existsSync(sdk), false)
  assert.equal(fs.existsSync(link), false)
  assert.equal(fs.readFileSync(path.join(root, 'native-preparation.txt'), 'utf8'), 'complete')
  assert.equal(fs.readFileSync(path.join(root, 'host-binaries.txt'), 'utf8'), 'complete')
})

test('public installation refuses existing SDK sources, shared dependencies and unrecognized generated content', context => {
  const original = workspace(context)
  original.write('src/sdk/halo-sdk/package.json', 'existing SDK')
  assert.throws(() => prepareDependencies(original.root, 'install', { run: () => assert.fail('installation must not start') }), /existing SDK paths/)
  assert.equal(fs.readFileSync(path.join(original.sdk, 'package.json'), 'utf8'), 'existing SDK')
  const linked = workspace(context)
  fs.mkdirSync(path.dirname(linked.sdk), { recursive: true })
  linkDirectory(original.sdk, linked.sdk)
  assert.throws(() => prepareDependencies(linked.root, 'install', { run: () => assert.fail('installation must not start') }), /existing SDK paths/)
  const shared = workspace(context)
  linkDirectory(original.root, path.join(shared.root, 'node_modules'))
  assert.throws(() => prepareDependencies(shared.root, 'install', { run: () => assert.fail('installation must not start') }), /shared symbolic link/)
  const unexpected = workspace(context)
  assert.throws(() => prepareDependencies(unexpected.root, 'install', { run() { unexpected.write('src/sdk/halo-sdk/package.json', 'do not remove') } }), /unexpected SDK source/)
  assert.equal(fs.readFileSync(path.join(unexpected.sdk, 'package.json'), 'utf8'), 'do not remove')
})

test('public cleanup rejects external links without deleting the linked files', context => {
  const { root, write } = workspace(context)
  const external = workspace(context)
  external.write('retained.txt', 'keep')
  assert.throws(() => prepareDependencies(root, 'install', { run() {
    write('src/sdk/halo-sdk/node_modules/owned.txt', 'owned')
    linkDirectory(external.root, path.join(root, 'src/sdk/halo-sdk/node_modules/shared'))
  } }), /external link/)
  assert.equal(fs.readFileSync(path.join(external.root, 'retained.txt'), 'utf8'), 'keep')
})

test('SDK preparation builds its own pinned clean checkout and binding is idempotent', context => {
  const { root, sdk, revision, environment, link, git } = checkout(context)
  const result = prepareDependencies(root, 'sdk', { environment })
  assert.equal(result.revision, revision)
  assert.equal(git(['status', '--porcelain']), '')
  const bytes = fs.readFileSync(path.join(sdk, 'dist/index.js'))
  assert.equal(prepareDependencies(root, 'bind-sdk', { environment }).revision, revision)
  assert.equal(fs.realpathSync(link), sdk)
  prepareDependencies(root, 'bind-sdk', { environment })
  assert.deepEqual(fs.readFileSync(path.join(sdk, 'dist/index.js')), bytes)
})

test('SDK binding refuses a wrong commit, dirty source, absent runtime and an existing unrelated installation', context => {
  const fixture = checkout(context, { built: true })
  const { root, environment, write, link } = fixture
  assert.throws(() => prepareDependencies(root, 'bind-sdk', { environment: { ...environment, HALO_SDK_REVISION: 'f'.repeat(40) } }), /does not match/)
  write('src/sdk/halo-sdk/uncommitted.txt', 'dirty')
  assert.throws(() => prepareDependencies(root, 'bind-sdk', { environment }), /local changes/)
  fs.unlinkSync(path.join(fixture.sdk, 'uncommitted.txt'))
  fs.unlinkSync(path.join(fixture.sdk, 'dist/worker/index.js'))
  assert.throws(() => prepareDependencies(root, 'bind-sdk', { environment }), /runtime entry is missing/)
  write('src/sdk/halo-sdk/dist/worker/index.js', 'worker')
  write('node_modules/@hello-halo/agent-sdk/package.json', 'installed SDK')
  assert.throws(() => prepareDependencies(root, 'bind-sdk', { environment }), /will not be replaced/)
  assert.equal(fs.readFileSync(path.join(link, 'package.json'), 'utf8'), 'installed SDK')
})

test('a prebuilt linked SDK is read-only: binding is allowed while installation and SDK rebuilding refuse it', context => {
  const external = checkout(context, { built: true })
  const fixture = workspace(context)
  fs.mkdirSync(path.dirname(fixture.sdk), { recursive: true })
  fs.mkdirSync(path.join(fixture.root, 'node_modules'), { recursive: true })
  linkDirectory(external.sdk, fixture.sdk)
  const run = () => assert.fail('shared SDK must not execute installation or build commands')
  assert.throws(() => prepareDependencies(fixture.root, 'install', { run }), /existing SDK paths/)
  assert.throws(() => prepareDependencies(fixture.root, 'sdk', { environment: external.environment, run }), /shared or linked SDKs/)
  prepareDependencies(fixture.root, 'bind-sdk', { environment: external.environment, run })
  assert.equal(fs.realpathSync(fixture.link), external.sdk)
  assert.equal(external.git(['status', '--porcelain']), '')
})

test('the workflow installs public dependencies before SDK checkout, build and binding', () => {
  const workflow = parse(fs.readFileSync(path.join(repository, 'tests/acceptance/ci/acceptance.yml'), 'utf8'))
  const steps = workflow.jobs.acceptance.steps
  const index = command => steps.findIndex(step => step.run === command)
  const install = index('node scripts/acceptance/ci-prepare.mjs install')
  const checkout = steps.findIndex(step => step.uses === 'actions/checkout@v4' && step.with.path === 'halo/src/sdk/halo-sdk')
  const buildSdk = index('node scripts/acceptance/ci-prepare.mjs sdk')
  const bind = index('node scripts/acceptance/ci-prepare.mjs bind-sdk')
  const buildApplication = index('node scripts/acceptance/cli.mjs build')
  assert(install >= 0 && install < checkout && checkout < buildSdk && buildSdk < bind && bind < buildApplication)
  for (const i of [checkout, buildSdk, bind]) assert.equal(steps[i].if, "vars.HALO_SDK_REPOSITORY != ''")
  assert.equal(steps[checkout].with['persist-credentials'], false)
  assert.equal(steps[checkout].with.ref, '${{ vars.HALO_SDK_REVISION }}')
  assert.equal(steps[checkout].with['ssh-key'], '${{ secrets.HALO_SDK_READ_SSH_KEY }}')
  assert.equal(steps[checkout].with.token, "${{ secrets.HALO_SDK_READ_SSH_KEY != '' && github.token || secrets.HALO_SDK_READ_TOKEN || github.token }}")
})
