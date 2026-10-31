import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { git } from './ci-state.mjs'

const sdkName = '@hello-halo/agent-sdk'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

function runCommand(command, args, cwd, environment) {
  const result = spawnSync(command, args, { cwd, env: environment, stdio: 'inherit', shell: process.platform === 'win32' && command === npm })
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} ${args[0]} failed (${result.error?.message ?? result.signal ?? result.status}).`)
}

function stat(file) {
  try { return fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function ownedParents(root, file) {
  if (!inside(root, file)) throw new Error('Dependency preparation leaves the application checkout.')
  let directory = path.dirname(file)
  while (directory !== root) {
    const entry = stat(directory)
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Dependency preparation cannot traverse a linked or non-directory parent.')
    directory = path.dirname(directory)
  }
}

function sourceManifests(directory) {
  return new Map(['package.json', 'package-lock.json', 'yarn.lock'].map(name => {
    const file = path.join(directory, name)
    const entry = stat(file)
    if (entry && !entry.isFile()) throw new Error(`Dependency preparation requires a regular ${name}.`)
    return [name, entry ? fs.readFileSync(file) : null]
  }))
}

function verifySourceManifests(directory, before, stage) {
  const after = sourceManifests(directory)
  for (const [name, previous] of before) {
    const current = after.get(name)
    if (previous === null ? current !== null : current === null || !previous.equals(current)) throw new Error(`${stage} changed ${name}; source manifests and locks were not reset.`)
  }
}

function lockedNpmInstall(directory, args, environment, run) {
  const before = sourceManifests(directory)
  const yarn = path.join(directory, 'yarn.lock')
  let temporary
  if (before.get('yarn.lock')) {
    // npm ci can rewrite a loaded Yarn lock when saving its hidden npm lock.
    temporary = fs.mkdtempSync(path.join(directory, '.acceptance-lock-'))
    fs.renameSync(yarn, path.join(temporary, 'yarn.lock'))
  }
  let failure
  try { run(npm, args, directory, environment) }
  catch (error) { failure = error }
  finally {
    if (temporary) {
      const retained = path.join(temporary, 'yarn.lock')
      if (stat(yarn)) throw new Error(`Dependency installation created an unexpected yarn.lock; it was not overwritten. The original is retained in ${path.basename(temporary)}/yarn.lock.`, { cause: failure })
      if (!stat(retained)?.isFile() || !before.get('yarn.lock').equals(fs.readFileSync(retained))) throw new Error(`The retained Yarn lock changed; inspect ${path.basename(temporary)}/yarn.lock before continuing.`, { cause: failure })
      fs.renameSync(retained, yarn)
      fs.rmdirSync(temporary)
    }
  }
  verifySourceManifests(directory, before, 'Locked npm installation')
  if (failure) throw failure
}

export function browserEnvironment(source = process.env) {
  const environment = { ...source, PLAYWRIGHT_SKIP_BROWSER_GC: '1' }
  for (const name of ['PLAYWRIGHT_BROWSERS_PATH', 'npm_config_playwright_browsers_path', 'npm_package_config_playwright_browsers_path']) delete environment[name]
  return environment
}

function chromiumInstallation(root, environment) {
  const require = createRequire(path.join(root, 'package.json'))
  const descriptorFile = require.resolve('playwright/package.json')
  const descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'))
  const playwrightRequire = createRequire(descriptorFile)
  const coreFile = playwrightRequire.resolve('playwright-core/package.json')
  const core = JSON.parse(fs.readFileSync(coreFile, 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  if (lock.packages?.['node_modules/playwright']?.version !== descriptor.version || lock.packages?.['node_modules/playwright-core']?.version !== core.version || descriptor.dependencies?.['playwright-core'] !== core.version) throw new Error('Installed Playwright versions do not match the application lock; install locked dependencies first.')
  const entry = typeof descriptor.bin === 'string' ? descriptor.bin : descriptor.bin?.playwright
  if (typeof entry !== 'string') throw new Error('The installed Playwright package has no CLI entry.')
  const cli = path.resolve(path.dirname(descriptorFile), entry)
  if (!inside(path.dirname(descriptorFile), cli) || !stat(cli)?.isFile()) throw new Error('The installed Playwright CLI entry is unavailable.')
  const registry = playwrightRequire.resolve('playwright-core/lib/server/registry/index')
  const probe = spawnSync(process.execPath, ['-e', `const {registry,registryDirectory}=require(process.argv[1]); const targets=[...new Map(registry.resolveBrowsers(['chromium'],{}).map(entry=>[entry.name,entry])).values()].map(entry=>({name:entry.name,directory:entry.directory,executable:entry.executablePath('javascript')})); process.stdout.write(JSON.stringify({cacheDirectory:registryDirectory,targets}));`, registry], { cwd: root, env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (probe.error || probe.status !== 0) throw new Error('The installed Playwright package could not describe its Chromium runtime.')
  const runtime = JSON.parse(probe.stdout)
  if (typeof runtime.cacheDirectory !== 'string' || !path.isAbsolute(runtime.cacheDirectory) || path.basename(runtime.cacheDirectory) !== 'ms-playwright' || !Array.isArray(runtime.targets) || !runtime.targets.length) throw new Error('Playwright did not resolve its standard isolated browser cache.')
  for (const target of runtime.targets) {
    if (typeof target.name !== 'string' || typeof target.directory !== 'string' || typeof target.executable !== 'string' || !path.isAbsolute(target.directory) || !path.isAbsolute(target.executable) || !inside(runtime.cacheDirectory, target.directory) || !inside(target.directory, target.executable)) throw new Error('A Chromium runtime entry leaves the Playwright browser cache.')
  }
  if (!runtime.targets.some(target => target.name === 'chromium') || !runtime.targets.some(target => target.name === 'chromium-headless-shell')) throw new Error('The installed Playwright package does not describe both Chromium and its headless runtime.')
  return { ...runtime, cli, version: descriptor.version }
}

function missingBrowserFiles(runtime) {
  const missing = []
  for (const target of runtime.targets) {
    const directory = stat(target.directory)
    if (directory && (!directory.isDirectory() || !inside(fs.realpathSync(runtime.cacheDirectory), fs.realpathSync(target.directory)))) throw new Error('A cached browser component is not a directory inside the Playwright cache.')
    const file = stat(target.executable)
    if (file?.isSymbolicLink()) throw new Error('A cached browser executable must not redirect to another installation.')
    if (!file?.isFile() || file.size === 0) { missing.push(target.name); continue }
    if (!inside(fs.realpathSync(runtime.cacheDirectory), fs.realpathSync(target.executable))) throw new Error('A cached browser executable resolves outside the Playwright cache.')
    try { fs.accessSync(target.executable, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK) }
    catch { missing.push(target.name) }
  }
  return missing
}

function removeGeneratedPlaceholder(root, sdk, link) {
  ownedParents(root, sdk)
  ownedParents(root, link)
  const installed = stat(link)
  if (installed) {
    if (!installed.isSymbolicLink() || path.resolve(path.dirname(link), fs.readlinkSync(link)) !== sdk) throw new Error('npm created an unexpected SDK installation; refusing to replace it.')
    fs.unlinkSync(link)
  }
  const directory = stat(sdk)
  if (!directory) return
  if (!directory.isDirectory() || directory.isSymbolicLink() || fs.readdirSync(sdk).some(name => name !== 'node_modules')) throw new Error('npm created an unexpected SDK source directory; refusing to remove it.')
  const inspect = file => {
    const entry = fs.lstatSync(file)
    if (entry.isSymbolicLink()) {
      if (!inside(sdk, fs.realpathSync(file))) throw new Error('An npm SDK placeholder contains an external link; refusing to remove it.')
    } else if (entry.isDirectory()) {
      for (const name of fs.readdirSync(file)) inspect(path.join(file, name))
    } else if (!entry.isFile()) throw new Error('An npm SDK placeholder contains a special file; refusing to remove it.')
  }
  inspect(sdk)
  fs.rmSync(sdk, { recursive: true })
  console.log('[Acceptance CI] Removed the dependency-only SDK placeholder generated by this public install.')
}

/** How the SDK's declared dependencies differ from the entry the application lock holds for it. */
function sdkLockDrift(root, real) {
  const lockFile = path.join(root, 'package-lock.json')
  if (!stat(lockFile)?.isFile()) return []
  const entry = JSON.parse(fs.readFileSync(lockFile, 'utf8')).packages?.['src/sdk/halo-sdk']
  if (!entry) return []
  const declared = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'))
  const differences = []
  for (const field of ['dependencies', 'optionalDependencies']) {
    const locked = entry[field] ?? {}
    const actual = declared[field] ?? {}
    for (const name of [...new Set([...Object.keys(locked), ...Object.keys(actual)])].sort()) {
      if (locked[name] !== actual[name]) differences.push(`${name} ${locked[name] ?? 'absent'} -> ${actual[name] ?? 'absent'}`)
    }
  }
  return differences
}

function sdkCheckout(root, environment, { writable = false, built = false } = {}) {
  const sdk = path.join(root, 'src/sdk/halo-sdk')
  const revision = environment.HALO_SDK_REVISION ?? ''
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('SDK preparation requires a fixed 40-character HALO_SDK_REVISION.')
  if (writable) {
    ownedParents(root, sdk)
    if (!stat(sdk)?.isDirectory() || stat(sdk)?.isSymbolicLink()) throw new Error('SDK builds require an owned checkout directory; shared or linked SDKs are read-only.')
    for (const name of ['node_modules', 'dist']) if (stat(path.join(sdk, name))?.isSymbolicLink()) throw new Error('SDK builds cannot use linked dependency or distribution directories.')
  }
  const real = fs.realpathSync(sdk)
  if (fs.realpathSync(git(['rev-parse', '--show-toplevel'], real)) !== real) throw new Error('The SDK must retain its own Git checkout identity.')
  if (git(['rev-parse', 'HEAD'], real) !== revision) throw new Error('The SDK checkout does not match HALO_SDK_REVISION.')
  if (git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'], real)) throw new Error('The SDK checkout has local changes; use the selected clean commit.')
  const descriptor = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'))
  if (descriptor.name !== sdkName) throw new Error('The SDK checkout does not contain the expected package.')
  if (built) {
    const entries = new Set([descriptor.main])
    const runtimeEntries = value => {
      if (typeof value === 'string' && /\.[cm]?js$/.test(value)) entries.add(value)
      else if (value && typeof value === 'object') for (const item of Object.values(value)) runtimeEntries(item)
    }
    runtimeEntries(descriptor.exports)
    for (const entry of entries) {
      if (typeof entry !== 'string' || !/^\.\/dist\//.test(entry) || entry.split(/[\\/]/).includes('..') || /[*?]/.test(entry)) throw new Error('The SDK does not declare a concrete compiled runtime entry under dist.')
      const file = path.join(real, entry)
      if (!stat(file)?.isFile() || !inside(path.join(real, 'dist'), fs.realpathSync(file)) || fs.statSync(file).size === 0) throw new Error('A declared SDK runtime entry is missing, empty or linked outside dist; build the pinned SDK first.')
    }
  }
  return { sdk, real, revision }
}

export function prepareDependencies(root, command, { environment = process.env, run = runCommand } = {}) {
  root = fs.realpathSync(root)
  if (command === 'browser') {
    const browserEnv = browserEnvironment(environment)
    const runtime = chromiumInstallation(root, browserEnv)
    const missing = missingBrowserFiles(runtime)
    if (!missing.length) {
      console.log(`[Acceptance CI] Reusing the matching Chromium runtime for Playwright ${runtime.version}.`)
      return { command, status: 'reused', playwrightVersion: runtime.version }
    }
    console.log(`[Acceptance CI] Preparing the locked Chromium runtime; missing components: ${missing.join(', ')}.`)
    run(process.execPath, [runtime.cli, 'install', 'chromium'], root, browserEnv)
    const remaining = missingBrowserFiles(runtime)
    if (remaining.length) throw new Error(`Chromium preparation completed without usable binaries: ${remaining.join(', ')}.`)
    console.log(`[Acceptance CI] Chromium runtime files are ready for Playwright ${runtime.version}; browser launch remains part of acceptance execution.`)
    return { command, status: 'installed', playwrightVersion: runtime.version }
  }
  const sdk = path.join(root, 'src/sdk/halo-sdk')
  const modules = path.join(root, 'node_modules')
  const link = path.join(modules, '@hello-halo/agent-sdk')
  if (command === 'install') {
    if (stat(path.join(root, '.env.local'))) throw new Error('Use a clean CI checkout without .env.local; test credentials must be explicit.')
    ownedParents(root, sdk)
    if (stat(modules)?.isSymbolicLink()) throw new Error('Application node_modules must not be a shared symbolic link.')
    ownedParents(root, link)
    if (stat(link)) throw new Error('An SDK is already installed; use a clean dependency checkout.')
    // With the SDK in place the install follows the release procedure and the lock must agree with it; without it only public packages are installed.
    const selected = stat(sdk) ? sdkCheckout(root, environment, { built: true }) : null
    if (selected) {
      const drift = sdkLockDrift(root, selected.real)
      if (drift.length) throw new Error(`The SDK at ${selected.revision} declares dependencies that differ from the application lock (${drift.slice(0, 6).join('; ')}); refresh the lock together with the SDK change.`)
    }
    const manifests = sourceManifests(root)
    lockedNpmInstall(root, ['ci', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], environment, run)
    if (selected) {
      if (!stat(link)?.isSymbolicLink() || !fs.existsSync(link) || fs.realpathSync(link) !== selected.real) throw new Error('The dependency install did not link the selected SDK checkout.')
    } else removeGeneratedPlaceholder(root, sdk, link)
    run(process.execPath, ['scripts/postinstall.mjs'], root, { ...environment, PATH: `${path.join(modules, '.bin')}${path.delimiter}${environment.PATH ?? ''}` })
    verifySourceManifests(root, manifests, 'Native dependency preparation')
    if (!selected) removeGeneratedPlaceholder(root, sdk, link)
    run(npm, ['run', 'prepare'], root, environment)
    verifySourceManifests(root, manifests, 'Host binary preparation')
    if (selected) {
      console.log(`[Acceptance CI] Dependencies are ready with the SDK at ${selected.revision}.`)
      return { command, sdk: 'linked', revision: selected.revision }
    }
    console.log('[Acceptance CI] Public dependencies are ready; SDK execution remains unavailable until a pinned distribution is bound.')
    return { command, sdk: 'absent' }
  }
  if (command === 'sdk') {
    const before = sdkCheckout(root, environment, { writable: true })
    const manifests = sourceManifests(before.sdk)
    lockedNpmInstall(before.sdk, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], environment, run)
    run(npm, ['run', 'build'], before.sdk, environment)
    verifySourceManifests(before.sdk, manifests, 'SDK compilation')
    const after = sdkCheckout(root, environment, { writable: true, built: true })
    if (before.real !== after.real || before.revision !== after.revision) throw new Error('The SDK checkout changed while its distribution was being built.')
    console.log(`[Acceptance CI] Built the isolated SDK checkout at ${after.revision}.`)
    return { command, revision: after.revision }
  }
  if (command === 'bind-sdk') {
    const selected = sdkCheckout(root, environment, { built: true })
    if (!stat(modules)?.isDirectory() || stat(modules)?.isSymbolicLink()) throw new Error('Install independent public application dependencies before binding the SDK.')
    ownedParents(root, link)
    const existing = stat(link)
    if (existing) {
      if (!existing.isSymbolicLink() || !fs.existsSync(link) || fs.realpathSync(link) !== selected.real) throw new Error('An existing SDK installation points elsewhere or is not a link; it will not be replaced.')
    } else {
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.symlinkSync(process.platform === 'win32' ? selected.sdk : path.relative(path.dirname(link), selected.sdk), link, process.platform === 'win32' ? 'junction' : 'dir')
    }
    if (fs.realpathSync(link) !== selected.real) throw new Error('The installed SDK did not resolve to the selected checkout.')
    console.log(`[Acceptance CI] Bound the verified SDK distribution at ${selected.revision}; no SDK source or distribution files were changed.`)
    return { command, revision: selected.revision }
  }
  throw new Error('Usage: node scripts/acceptance/ci-prepare.mjs install|sdk|bind-sdk|browser')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { prepareDependencies(process.cwd(), process.argv[2]) }
  catch (error) { console.error(`[Acceptance CI] Dependency preparation blocked: ${error.message}`); process.exitCode = 1 }
}
