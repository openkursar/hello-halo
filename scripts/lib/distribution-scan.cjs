'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { forbiddenPath, sourceMapComments, assertTree } = require('./distribution-policy.cjs')

function isPrunedNativeEntry(relative, target) {
  const mappings = {
    'darwin-arm64': { watcher: 'watcher-darwin-arm64', canvas: 'canvas-darwin-arm64', pty: 'darwin-arm64', cloudflared: 'cloudflared' },
    'darwin-x64': { watcher: 'watcher-darwin-x64', canvas: 'canvas-darwin-x64', pty: 'darwin-x64', cloudflared: 'cloudflared' },
    'win32-x64': { watcher: 'watcher-win32-x64', canvas: 'canvas-win32-x64-msvc', pty: 'win32-x64', cloudflared: 'cloudflared.exe' },
    'linux-x64': { watcher: 'watcher-linux-x64-glibc', canvas: 'canvas-linux-x64-gnu', pty: null, cloudflared: 'cloudflared' }
  }
  const selected = mappings[target]
  if (!selected) return false
  const watcher = /^node_modules\/@parcel\/(watcher-(?:darwin-arm64|darwin-x64|linux-x64-glibc|win32-x64))\//.exec(relative)
  if (watcher) return watcher[1] !== selected.watcher
  const canvas = /^node_modules\/@napi-rs\/(canvas-(?:darwin-arm64|darwin-x64|linux-x64-gnu|win32-x64-msvc))\//.exec(relative)
  if (canvas) return canvas[1] !== selected.canvas
  const pty = /^(?:resources\/dsh-runtime\/)?node_modules\/node-pty\/prebuilds\/(darwin-arm64|darwin-x64|win32-arm64|win32-x64|linux-arm64|linux-x64)\//.exec(relative)
  if (pty) return pty[1] !== selected.pty || relative.endsWith('.pdb')
  // Host-built binaries that afterPack drops from packages for another platform or chip.
  if (/^node_modules\/node-pty\/(?:build|bin)\//.test(relative)) return target !== `${process.platform}-${process.arch}`
  const conpty = /^node_modules\/node-pty\/third_party\/conpty\/[^/]+\/win10-(x64|arm64)\//.exec(relative)
  if (conpty) return target.startsWith('win32-') && target !== `win32-${conpty[1]}`
  const sqlite = /^node_modules\/better-sqlite3\/prebuilds\/(darwin-arm64|darwin-x64|win32-x64|win32-arm64|linux-x64|linux-arm64|linuxmusl-arm64|linuxmusl-x64)\.node$/.exec(relative)
  if (sqlite) return sqlite[1] !== target
  if (/^node_modules\/cloudflared\/bin\/(?:cloudflared|cloudflared\.exe|cloudflared-darwin-x64|cloudflared-linux-x64)\.version$/.test(relative)) return true
  const cloudflared = /^node_modules\/cloudflared\/bin\/(cloudflared|cloudflared\.exe|cloudflared-darwin-x64|cloudflared-linux-x64)$/.exec(relative)
  if (cloudflared) return cloudflared[1] !== selected.cloudflared
  const { RUNTIME_DIR, allNativeCompanions, nativeCompanionsFor } = require('../../runtimes/dsh/manifest.cjs')
  const privatePrefix = `${RUNTIME_DIR}/node_modules/`
  if (relative.startsWith(privatePrefix)) {
    const privatePath = relative.slice(privatePrefix.length)
    const kept = new Set(nativeCompanionsFor(target))
    for (const name of allNativeCompanions()) {
      if (!kept.has(name) && privatePath.startsWith(`${name}/`)) return true
    }
    if (/^node-pty\/(?:build|src|deps|node-addon-api|third_party|scripts|typings)\//.test(privatePath) || privatePath === 'node-pty/binding.gyp') return true
  }
  const { RIPGREP_TARGETS } = require('./ripgrep.cjs')
  for (const [key, value] of Object.entries(RIPGREP_TARGETS)) {
    if (key !== target && relative.startsWith(`node_modules/${value.packageName}/`)) return true
  }
  return false
}

function assertDistribution(resources, options = {}) {
  const target = options.target || `${process.platform}-${process.arch}`
  const archive = path.join(resources, 'app.asar')
  let packed = 0
  if (fs.existsSync(archive)) {
    const asar = require('@electron/asar')
    for (const entry of asar.listPackage(archive)) {
      const relative = entry.replace(/^[\\/]/, '').replaceAll('\\', '/')
      const stat = asar.statFile(archive, relative)
      if (stat.files) continue
      const reason = forbiddenPath(relative)
      if (reason) throw new Error(`[distribution] Forbidden ASAR ${reason}: ${relative}`)
      if (stat.unpacked) {
        if (!fs.existsSync(path.join(resources, 'app.asar.unpacked', relative))) {
          if (isPrunedNativeEntry(relative, target)) continue
          throw new Error(`[distribution] Missing unpacked ASAR file for ${target}: ${relative}`)
        }
      } else if (relative.endsWith('.map')) {
        if (stat.size > 128 * 1024 * 1024) throw new Error(`[distribution] ASAR map exceeds scan limit: ${relative}`)
        try {
          const value = JSON.parse(asar.extractFile(archive, relative).toString('utf8'))
          if (value?.version === 3 && (Array.isArray(value.sources) || Array.isArray(value.sections))) throw new Error(`[distribution] ASAR source map: ${relative}`)
        } catch (error) { if (!(error instanceof SyntaxError)) throw error }
      } else if (/\.(?:[cm]?js|css)$/.test(relative)) {
        if (stat.size > 128 * 1024 * 1024) throw new Error(`[distribution] ASAR code exceeds scan limit: ${relative}`)
        if (sourceMapComments(asar.extractFile(archive, relative).toString('utf8'), path.extname(relative)).length) {
          throw new Error(`[distribution] ASAR source map directive: ${relative}`)
        }
      }
      packed++
    }
  }
  const { files } = assertTree(resources)
  console.log(`[distribution] Verified ${packed} ASAR entries and ${files} resource files`)
  return { packed, files }
}

module.exports = { assertDistribution, isPrunedNativeEntry }
