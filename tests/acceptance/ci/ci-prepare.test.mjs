import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
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

test('a real offline npm install preserves both source locks while installing an actual local dependency', context => {
  const { root, write } = workspace(context)
  write('seed/package.json', JSON.stringify({ name: 'fixture-runtime', version: '1.0.0' }))
  write('seed/index.js', 'module.exports = 1')
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npm = (args, cwd = root) => execFileSync(npmCommand, args, { cwd, env: { ...process.env, npm_config_offline: 'true' }, stdio: 'pipe', shell: process.platform === 'win32' })
  npm(['pack', '--ignore-scripts', '--offline', '--pack-destination', root], path.join(root, 'seed'))
  write('package.json', JSON.stringify({ name: 'dual-lock-fixture', version: '1.0.0', scripts: { prepare: 'node scripts/prepare.mjs' }, dependencies: { 'fixture-runtime': 'file:fixture-runtime-1.0.0.tgz' } }))
  npm(['install', '--package-lock-only', '--ignore-scripts', '--legacy-peer-deps', '--offline', '--no-audit', '--no-fund'])
  const yarn = '# yarn lockfile v1\n\n"fixture-runtime@file:fixture-runtime-1.0.0.tgz":\n  version "1.0.0"\n  resolved "file:fixture-runtime-1.0.0.tgz"\n\nunused@^1.0.0:\n  version "1.0.0"\n'
  write('yarn.lock', yarn)
  write('scripts/postinstall.mjs', 'export {}')
  write('scripts/prepare.mjs', 'export {}')
  const npmLock = fs.readFileSync(path.join(root, 'package-lock.json'))
  prepareDependencies(root, 'install', { environment: { ...process.env, npm_config_offline: 'true' } })
  assert.equal(fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8'), yarn)
  assert.deepEqual(fs.readFileSync(path.join(root, 'package-lock.json')), npmLock)
  assert.equal(fs.readFileSync(path.join(root, 'node_modules/fixture-runtime/index.js'), 'utf8'), 'module.exports = 1')
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.acceptance-lock-')), false)
})

test('failed npm installation restores the original Yarn lock but never overwrites an unexpected new lock', context => {
  const retained = workspace(context)
  retained.write('yarn.lock', 'original lock')
  assert.throws(() => prepareDependencies(retained.root, 'install', { run() {
    assert.equal(fs.existsSync(path.join(retained.root, 'yarn.lock')), false)
    throw new Error('fixture npm failure')
  } }), /fixture npm failure/)
  assert.equal(fs.readFileSync(path.join(retained.root, 'yarn.lock'), 'utf8'), 'original lock')
  assert.equal(fs.readdirSync(retained.root).some(name => name.startsWith('.acceptance-lock-')), false)
  const conflict = workspace(context)
  conflict.write('yarn.lock', 'original lock')
  assert.throws(() => prepareDependencies(conflict.root, 'install', { run() { conflict.write('yarn.lock', 'unexpected new lock') } }), /unexpected yarn.lock; it was not overwritten/)
  assert.equal(fs.readFileSync(path.join(conflict.root, 'yarn.lock'), 'utf8'), 'unexpected new lock')
  const backup = fs.readdirSync(conflict.root).find(name => name.startsWith('.acceptance-lock-'))
  assert.equal(fs.readFileSync(path.join(conflict.root, backup, 'yarn.lock'), 'utf8'), 'original lock')
})

test('manifest or lock changes during installation hooks fail without resetting the evidence', context => {
  for (const stage of ['ci', 'scripts/postinstall.mjs', 'run']) {
    const selected = workspace(context)
    selected.write('package-lock.json', '{}')
    assert.throws(() => prepareDependencies(selected.root, 'install', { run(command, args) {
      if (args[0] === stage) selected.write('package-lock.json', '{"unexpected":true}')
    } }), /changed package-lock.json/)
    assert.equal(fs.readFileSync(path.join(selected.root, 'package-lock.json'), 'utf8'), '{"unexpected":true}')
  }
})

test('installation refuses an unverified SDK path, shared dependencies and unrecognized generated content', context => {
  const original = workspace(context)
  original.write('src/sdk/halo-sdk/package.json', 'existing SDK')
  assert.throws(() => prepareDependencies(original.root, 'install', { run: () => assert.fail('installation must not start') }), /fixed 40-character HALO_SDK_REVISION/)
  assert.equal(fs.readFileSync(path.join(original.sdk, 'package.json'), 'utf8'), 'existing SDK')
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

test('a prebuilt linked SDK is read-only: it can be installed against and bound but never rebuilt', context => {
  const external = checkout(context, { built: true })
  const fixture = workspace(context)
  fs.mkdirSync(path.dirname(fixture.sdk), { recursive: true })
  fs.mkdirSync(path.join(fixture.root, 'node_modules'), { recursive: true })
  linkDirectory(external.sdk, fixture.sdk)
  const run = () => assert.fail('shared SDK must not execute installation or build commands')
  assert.throws(() => prepareDependencies(fixture.root, 'sdk', { environment: external.environment, run }), /shared or linked SDKs/)
  prepareDependencies(fixture.root, 'bind-sdk', { environment: external.environment, run })
  assert.equal(fs.realpathSync(fixture.link), external.sdk)
  assert.equal(external.git(['status', '--porcelain']), '')
})

function lockWith(fixture, dependencies) {
  fixture.write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'src/sdk/halo-sdk': { name: '@hello-halo/agent-sdk', version: '1.0.0', ...(dependencies ? { dependencies } : {}) } } }))
}

test('installing with a built clean SDK checkout follows the release procedure: npm links the checkout and nothing is removed', context => {
  const fixture = checkout(context, { built: true })
  lockWith(fixture)
  const calls = []
  const result = prepareDependencies(fixture.root, 'install', { environment: fixture.environment, run(command, args, cwd) {
    calls.push(args[0])
    assert.equal(cwd, fixture.root)
    if (args[0] === 'ci') {
      assert.equal(fs.existsSync(path.join(fixture.sdk, 'dist/index.js')), true)
      fs.mkdirSync(path.dirname(fixture.link), { recursive: true })
      linkDirectory(fixture.sdk, fixture.link)
    }
  } })
  assert.deepEqual(result, { command: 'install', sdk: 'linked', revision: fixture.revision })
  assert.deepEqual(calls, ['ci', 'scripts/postinstall.mjs', 'run'])
  assert.equal(fs.realpathSync(fixture.link), fixture.sdk)
  assert.equal(fixture.git(['status', '--porcelain']), '')
})

test('installing with an SDK refuses a source that is not the clean, built, selected commit', context => {
  const unbuilt = checkout(context)
  assert.throws(() => prepareDependencies(unbuilt.root, 'install', { environment: unbuilt.environment, run: () => assert.fail('npm must not start') }), /runtime entry is missing/)
  const dirty = checkout(context, { built: true })
  dirty.write('src/sdk/halo-sdk/uncommitted.txt', 'dirty')
  assert.throws(() => prepareDependencies(dirty.root, 'install', { environment: dirty.environment, run: () => assert.fail('npm must not start') }), /local changes/)
  const other = checkout(context, { built: true })
  assert.throws(() => prepareDependencies(other.root, 'install', { environment: { ...other.environment, HALO_SDK_REVISION: 'f'.repeat(40) }, run: () => assert.fail('npm must not start') }), /does not match/)
})

test('an SDK whose declared dependencies differ from the application lock is named before npm runs', context => {
  const fixture = checkout(context, { built: true })
  lockWith(fixture, { zod: '^3.0.0' })
  assert.throws(() => prepareDependencies(fixture.root, 'install', { environment: fixture.environment, run: () => assert.fail('npm must not start') }),
    new RegExp(`SDK at ${fixture.revision} declares dependencies that differ from the application lock \\(zod \\^3\\.0\\.0 -> absent\\)`))
})

test('an install that links something other than the selected SDK checkout is refused', context => {
  const fixture = checkout(context, { built: true })
  const elsewhere = workspace(context)
  assert.throws(() => prepareDependencies(fixture.root, 'install', { environment: fixture.environment, run(command, args) {
    if (args[0] === 'ci') {
      fs.mkdirSync(path.dirname(fixture.link), { recursive: true })
      linkDirectory(elsewhere.root, fixture.link)
    }
  } }), /did not link the selected SDK/)
})

test('the workflow selects, checks out and builds the SDK before installing against it, then verifies the link', () => {
  const workflow = parse(fs.readFileSync(path.join(repository, 'tests/acceptance/ci/acceptance.yml'), 'utf8'))
  const steps = workflow.jobs.acceptance.steps
  const index = command => steps.findIndex(step => step.run === command)
  const select = steps.findIndex(step => step.id === 'sdk-select')
  const checkout = steps.findIndex(step => step.uses === 'actions/checkout@v4' && step.with.path === 'halo/src/sdk/halo-sdk')
  const fix = steps.findIndex(step => step.name === 'Fix the SDK revision')
  const buildSdk = index('node scripts/acceptance/ci-prepare.mjs sdk')
  const install = index('node scripts/acceptance/ci-prepare.mjs install')
  const bind = index('node scripts/acceptance/ci-prepare.mjs bind-sdk')
  const buildApplication = index('node scripts/acceptance/cli.mjs build')
  assert(select >= 0 && select < checkout && checkout < fix && fix < buildSdk && buildSdk < install && install < bind && bind < buildApplication)
  for (const i of [select, checkout, fix, buildSdk, bind]) assert.equal(steps[i].if, "vars.HALO_SDK_REPOSITORY != ''")
  assert.equal(steps[checkout].with['persist-credentials'], false)
  assert.equal(steps[checkout].with.ref, '${{ steps.sdk-select.outputs.ref }}')
  assert.equal(steps[checkout].with['ssh-key'], '${{ secrets.HALO_SDK_READ_SSH_KEY }}')
  assert.equal(steps[checkout].with.token, "${{ secrets.HALO_SDK_READ_SSH_KEY != '' && github.token || secrets.HALO_SDK_READ_TOKEN || github.token }}")
  assert.equal(workflow.jobs.acceptance.env.HALO_SDK_REVISION, undefined)
  assert.match(steps[fix].run, /rev-parse HEAD/)
  assert.match(steps[fix].run, /GITHUB_ENV/)
})

test('the SDK follows a branch or an input, falls back to a pinned commit, and refuses to guess', () => {
  const workflow = parse(fs.readFileSync(path.join(repository, 'tests/acceptance/ci/acceptance.yml'), 'utf8'))
  const step = workflow.jobs.acceptance.steps.find(candidate => candidate.id === 'sdk-select')
  assert.deepEqual(Object.keys(step.env).sort(), ['SDK_PIN', 'SDK_REF_INPUT', 'SDK_REF_VARIABLE'])
  const choose = env => {
    const output = path.join(os.tmpdir(), `sdk-select-${process.pid}-${Math.random().toString(16).slice(2)}`)
    fs.writeFileSync(output, '')
    try {
      const result = spawnSync('bash', ['-ec', step.run], { env: { PATH: process.env.PATH, SDK_REF_INPUT: '', SDK_REF_VARIABLE: '', SDK_PIN: '', ...env, GITHUB_OUTPUT: output }, encoding: 'utf8' })
      return { status: result.status, output: fs.readFileSync(output, 'utf8').trim(), error: result.stdout + result.stderr }
    } finally { fs.rmSync(output, { force: true }) }
  }
  assert.equal(choose({ SDK_REF_INPUT: 'topic/work', SDK_REF_VARIABLE: 'release', SDK_PIN: 'c'.repeat(40) }).output, 'ref=topic/work')
  assert.equal(choose({ SDK_REF_VARIABLE: 'release', SDK_PIN: 'c'.repeat(40) }).output, 'ref=release')
  assert.equal(choose({ SDK_PIN: 'c'.repeat(40) }).output, `ref=${'c'.repeat(40)}`)
  assert.match(choose({}).error, /Set HALO_SDK_REF/)
  for (const unsafe of ['-bad', 'a b', 'x;y', '$(id)', 'refs/pull/7/head', 'refs/heads/main']) assert.notEqual(choose({ SDK_REF_INPUT: unsafe }).status, 0)
})
