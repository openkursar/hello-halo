import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { browserEnvironment, prepareDependencies } from '../../../scripts/acceptance/ci-prepare.mjs'

function fixture(context, behavior = 'install') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-browser-')))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
  const home = path.join(root, 'home')
  const cache = path.join(home, '.cache/ms-playwright')
  const environment = { ...process.env, HOME: home, USERPROFILE: home, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'unrelated-browser-data') }
  write('package.json', { name: 'browser-preparation-test', version: '1.0.0' })
  write('package-lock.json', { lockfileVersion: 3, packages: { 'node_modules/playwright': { version: '1.2.3' }, 'node_modules/playwright-core': { version: '1.2.3' } } })
  write('node_modules/playwright/package.json', { name: 'playwright', version: '1.2.3', bin: { playwright: 'cli.cjs' }, dependencies: { 'playwright-core': '1.2.3' } })
  write('node_modules/playwright-core/package.json', { name: 'playwright-core', version: '1.2.3', exports: { './package.json': './package.json', './lib/server/registry/index': './registry.cjs' } })
  write('node_modules/playwright-core/registry.cjs', `
const path=require('node:path');
const registryDirectory=path.join(process.env.HOME,'.cache/ms-playwright');
const targets=['chromium','chromium-headless-shell','ffmpeg'].map(name=>({name,directory:path.join(registryDirectory,name+'-locked'),executablePath:()=>path.join(registryDirectory,name+'-locked','binary')}));
exports.registryDirectory=registryDirectory;
exports.registry={resolveBrowsers:()=>targets};
`)
  write('node_modules/playwright/cli.cjs', `
const fs=require('node:fs'),path=require('node:path');
const {registry}=require('playwright-core/lib/server/registry/index');
fs.writeFileSync('browser-install-call.json',JSON.stringify({args:process.argv.slice(2),customCache:process.env.PLAYWRIGHT_BROWSERS_PATH??null,skipGarbageCollection:process.env.PLAYWRIGHT_SKIP_BROWSER_GC}));
if(${JSON.stringify(behavior)}==='fail')process.exit(9);
for(const entry of registry.resolveBrowsers(['chromium'],{})){
  if(${JSON.stringify(behavior)}==='omit-headless'&&entry.name==='chromium-headless-shell')continue;
  fs.mkdirSync(entry.directory,{recursive:true});fs.writeFileSync(entry.executablePath(),'fixture binary, never executed');fs.chmodSync(entry.executablePath(),0o755);
}
`)
  const binaries = ['chromium', 'chromium-headless-shell', 'ffmpeg'].map(name => path.join(cache, name + '-locked/binary'))
  const populate = () => { for (const file of binaries) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'existing locked fixture binary'); fs.chmodSync(file, 0o755) } }
  return { root, environment, write, binaries, populate }
}

test('CI browser environment uses the standard isolated cache without mutating the caller or pruning other versions', () => {
  const original = { PATH: '/path', PLAYWRIGHT_BROWSERS_PATH: '/user-browser', npm_config_playwright_browsers_path: '/another', npm_package_config_playwright_browsers_path: '0', PLAYWRIGHT_SKIP_BROWSER_GC: '0' }
  const result = browserEnvironment(original)
  assert.equal(result.PLAYWRIGHT_BROWSERS_PATH, undefined)
  assert.equal(result.npm_config_playwright_browsers_path, undefined)
  assert.equal(result.npm_package_config_playwright_browsers_path, undefined)
  assert.equal(result.PLAYWRIGHT_SKIP_BROWSER_GC, '1')
  assert.equal(result.PATH, '/path')
  assert.equal(original.PLAYWRIGHT_BROWSERS_PATH, '/user-browser')
})

test('all matching cached Chromium components are reused without invoking the installer', context => {
  const selected = fixture(context)
  selected.populate()
  const before = selected.binaries.map(file => fs.readFileSync(file, 'utf8'))
  const result = prepareDependencies(selected.root, 'browser', { environment: selected.environment })
  assert.deepEqual(result, { command: 'browser', status: 'reused', playwrightVersion: '1.2.3' })
  assert.equal(fs.existsSync(path.join(selected.root, 'browser-install-call.json')), false)
  assert.deepEqual(selected.binaries.map(file => fs.readFileSync(file, 'utf8')), before)
})

test('missing Chromium uses the installed locked CLI and verifies both headed and headless binaries', context => {
  const selected = fixture(context)
  const result = prepareDependencies(selected.root, 'browser', { environment: selected.environment })
  assert.equal(result.status, 'installed')
  const invocation = JSON.parse(fs.readFileSync(path.join(selected.root, 'browser-install-call.json'), 'utf8'))
  assert.deepEqual(invocation, { args: ['install', 'chromium'], customCache: null, skipGarbageCollection: '1' })
  assert(selected.binaries.every(file => fs.statSync(file).isFile()))
  assert.equal(fs.existsSync(selected.environment.PLAYWRIGHT_BROWSERS_PATH), false)
})

test('installer failure and success with a missing headless binary both block browser preparation', context => {
  const failed = fixture(context, 'fail')
  assert.throws(() => prepareDependencies(failed.root, 'browser', { environment: failed.environment }), /failed \(9\)/)
  const incomplete = fixture(context, 'omit-headless')
  assert.throws(() => prepareDependencies(incomplete.root, 'browser', { environment: incomplete.environment }), /without usable binaries: chromium-headless-shell/)
  assert.equal(fs.existsSync(incomplete.binaries[0]), true)
  assert.equal(fs.existsSync(incomplete.binaries[1]), false)
})

test('an installed package version outside the lock cannot select or download another browser revision', context => {
  const selected = fixture(context)
  selected.write('package-lock.json', { packages: { 'node_modules/playwright': { version: '9.9.9' }, 'node_modules/playwright-core': { version: '1.2.3' } } })
  assert.throws(() => prepareDependencies(selected.root, 'browser', { environment: selected.environment }), /do not match the application lock/)
  assert.equal(fs.existsSync(path.join(selected.root, 'browser-install-call.json')), false)
})
