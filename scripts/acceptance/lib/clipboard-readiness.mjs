import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execute } from './process.mjs'

export async function macClipboardFailure(root, {
  platform = process.platform, environment = process.env, filesystem = fs, run = execute,
} = {}) {
  if (platform !== 'darwin') return 'Complete native clipboard preservation requires the macOS AppKit fixture; this platform has no full-format fixture backend'
  let directory, retained = false, failure = null
  const executable = async filename => {
    try { return (await filesystem.stat(filename)).isFile() && await filesystem.access(filename, constants.X_OK).then(() => true) }
    catch { return false }
  }
  const isDirectory = async filename => {
    try { return (await filesystem.stat(filename)).isDirectory() }
    catch { return false }
  }
  const runOwned = async (...args) => {
    retained = true
    const result = await run(...args)
    retained = Boolean(result.cleanupFailed)
    return result
  }
  const probe = async () => {
    if (!await executable('/usr/bin/xcode-select') || !await executable('/usr/bin/xcrun')) return 'The macOS clipboard fixture requires installed developer-selection tools; no installation was requested'
    directory = await filesystem.mkdtemp(path.join(os.tmpdir(), 'halo-clipboard-readiness-'))
    const receipt = path.join(directory, 'developer-directory.txt')
    // Keep the selected path out of captured process logs, which are deliberately redacted.
    const select = await runOwned(root, ['-e', `const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const directory = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
writeFileSync(process.argv[1], directory, { mode: 0o600, flag: 'wx' });`, receipt], {
      executable: process.execPath, environment, timeoutMs: 5000, producerRole: 'clipboard-readiness',
    })
    if (select.cleanupFailed) { retained = true; return 'Clipboard developer-selection process exit is unconfirmed; owned probe files were retained' }
    if (select.code !== 0 || select.timedOut) return 'No usable macOS developer directory is selected; no installation was requested'
    const developer = (await filesystem.readFile(receipt, 'utf8')).trim()
    if (!path.posix.isAbsolute(developer) || /[\0\r\n]/.test(developer) || !await isDirectory(developer)) return 'The selected macOS developer directory is unavailable; no installation was requested'
    const compilers = [path.join(developer, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin', 'swiftc'), path.join(developer, 'usr', 'bin', 'swiftc')]
    if (!(await Promise.all(compilers.map(executable))).some(Boolean)) return 'The selected developer directory has no executable Swift compiler; no installation was requested'
    const sdks = [path.join(developer, 'Platforms', 'MacOSX.platform', 'Developer', 'SDKs', 'MacOSX.sdk'), path.join(developer, 'SDKs', 'MacOSX.sdk')]
    const appKit = await Promise.all(sdks.map(sdk => isDirectory(path.join(sdk, 'System', 'Library', 'Frameworks', 'AppKit.framework'))))
    if (!appKit.some(Boolean)) return 'The selected developer directory has no macOS SDK with AppKit; no installation was requested'
    if (environment.TOOLCHAINS && !['XcodeDefault', 'com.apple.dt.toolchain.XcodeDefault'].includes(environment.TOOLCHAINS)) return 'The clipboard fixture has no readiness backend for the selected custom Swift toolchain'
    const source = path.join(root, 'tests', 'e2e', 'fixtures', 'clipboard-macos.swift')
    if (!(await filesystem.stat(source)).isFile()) return 'The public complete-format clipboard helper source is unavailable'
    const output = path.join(directory, 'clipboard')
    const moduleCache = path.join(directory, 'module-cache')
    const compiled = await runOwned(root, ['--no-cache', 'swiftc', '-O', '-module-cache-path', moduleCache, source, '-o', output], {
      executable: '/usr/bin/xcrun', environment: { ...environment, DEVELOPER_DIR: developer, TMPDIR: directory + path.sep, CLANG_MODULE_CACHE_PATH: moduleCache }, timeoutMs: 30000, producerRole: 'clipboard-readiness',
    })
    if (compiled.cleanupFailed) { retained = true; return 'Clipboard compiler process exit is unconfirmed; owned probe files were retained' }
    if (compiled.code !== 0 || compiled.timedOut || !await executable(output)) return 'The selected Swift compiler and macOS SDK could not build the complete-format AppKit clipboard helper'
    return null
  }
  try { failure = await probe() }
  catch { failure = retained ? 'Clipboard readiness process exit is unconfirmed; owned probe files were retained' : 'The complete-format macOS clipboard readiness probe is unavailable' }
  finally {
    if (directory && !retained) {
      try { await filesystem.rm(directory, { recursive: true, force: true }) }
      catch { failure = 'Owned clipboard readiness files could not be removed; readiness is unconfirmed' }
    }
  }
  return failure
}
