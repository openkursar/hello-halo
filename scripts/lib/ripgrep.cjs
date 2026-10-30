'use strict'

// The ripgrep binary the Halo SDK engine's Grep tool runs, shipped as the
// per-platform packages of @vscode/ripgrep (pinned in package.json
// optionalDependencies). npm installs only the build host's package, so
// prepare-binaries.mjs fetches the target's for cross builds and afterPack.cjs
// keeps the target's alone.
//
// The runtime resolves the same path in src/main/services/agent/halo/ripgrep.ts;
// it runs inside the bundled main process and cannot require a build script.

const fs = require('node:fs')
const path = require('node:path')

/** Keyed by `${process.platform}-${process.arch}` of the machine that runs the app. */
const RIPGREP_TARGETS = {
  'darwin-arm64': { packageName: '@vscode/ripgrep-darwin-arm64', binary: 'rg' },
  'darwin-x64': { packageName: '@vscode/ripgrep-darwin-x64', binary: 'rg' },
  'win32-x64': { packageName: '@vscode/ripgrep-win32-x64', binary: 'rg.exe' },
  'linux-x64': { packageName: '@vscode/ripgrep-linux-x64', binary: 'rg' },
}

/** prepare-binaries.mjs platform names → target keys. */
const PREPARE_PLATFORM_KEYS = {
  'mac-arm64': 'darwin-arm64',
  'mac-x64': 'darwin-x64',
  win: 'win32-x64',
  linux: 'linux-x64',
}

/** Path of the binary inside a node_modules root, relative to it. */
function ripgrepBinaryPath(key) {
  const target = RIPGREP_TARGETS[key]
  return target ? path.join(...target.packageName.split('/'), 'bin', target.binary) : null
}

/** The version every platform package is pinned to. */
function pinnedRipgrepVersion(projectRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const versions = new Set(Object.values(RIPGREP_TARGETS).map(({ packageName }) => pkg.optionalDependencies?.[packageName]))
  if (versions.size !== 1 || versions.has(undefined)) {
    throw new Error('package.json optionalDependencies must pin every @vscode/ripgrep platform package to one version')
  }
  return [...versions][0]
}

module.exports = { RIPGREP_TARGETS, PREPARE_PLATFORM_KEYS, ripgrepBinaryPath, pinnedRipgrepVersion }
