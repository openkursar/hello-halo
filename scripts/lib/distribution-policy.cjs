'use strict'

const fs = require('node:fs')
const path = require('node:path')
const acorn = require('acorn')
const postcss = require('postcss')

const MAX_TEXT_BYTES = 128 * 1024 * 1024
const SDK_ROOT = 'node_modules/@hello-halo/agent-sdk/'
const OUTPUT_ROOTS = ['out/main/', 'out/preload/', 'out/renderer/']
const RESOURCE_ROOTS = ['ai-guides/', 'api-ref/', 'builtin-apps/', 'builtin-skills/', 'dsh-runtime/', 'providers/', 'tray/', 'linux/']
const RESOURCE_FILES = ['icon.png', 'icon.icns', 'icon.ico', 'trayTemplate.png', 'trayTemplate@2x.png', 'tray.png']

function forbiddenPath(file) {
  const normalized = file.replaceAll('\\', '/').replace(/^\/+/, '')
  if (/\.(?:[cm]?js|css)\.map$/i.test(normalized)) return 'source map'
  if (process.env.HALO_PRUNE_NODE_CANVAS === '1' && /(?:^|\/)node_modules\/@napi-rs\/canvas(?:-[^/]+)?(?:\/|$)/.test(normalized)) return 'optional Node canvas'
  if (/(?:^|\/)node_modules\/@openai\/codex(?:-sdk|-(?:darwin|linux|win32)-[^/]+)?(?:\/|$)/.test(normalized)) return 'bundled external Codex runtime'
  if (/(?:^|\/)(?:\.temp|\.halo|\.e2e[^/]*|\.acceptance[^/]*)(?:\/|$)/.test(normalized)) return 'development artifact'
  if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(normalized)) return 'test source'
  const sdkOffset = normalized.indexOf(SDK_ROOT)
  if (sdkOffset >= 0) {
    const relative = normalized.slice(sdkOffset + SDK_ROOT.length)
    if (!relative.startsWith('dist/') && !relative.startsWith('node_modules/') &&
        !/^(?:package\.json|LICENSE(?:\.[^/]*)?|NOTICE(?:\.[^/]*)?|THIRD-PARTY-NOTICES(?:\.[^/]*)?)$/i.test(relative)) return 'SDK non-runtime file'
    if (/\.(?:tgz|zip|tar|rs|ts|tsx)$/.test(relative)) return 'SDK development file'
  }
  if (normalized.startsWith('out/') && !OUTPUT_ROOTS.some(root => normalized.startsWith(root))) return 'non-production output'
  return null
}

function directive(value) {
  return /^\s*[#@]\s*sourceMappingURL\s*=/.test(value)
}

function sourceMapComments(source, extension) {
  if (!source.includes('sourceMappingURL')) return []
  const ranges = []
  if (extension === '.css') {
    const root = postcss.parse(source)
    root.walkComments(comment => {
      if (directive(comment.text)) ranges.push([comment.source.start.offset, comment.source.end.offset + 1])
    })
  } else {
    const onComment = (_block, text, start, end) => {
      if (directive(text)) ranges.push([start, end])
    }
    const options = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, onComment }
    try {
      acorn.parse(source, { ...options, sourceType: 'module' })
    } catch (error) {
      ranges.length = 0
      acorn.parse(source, { ...options, sourceType: 'script' })
    }
  }
  return ranges
}

function stripSourceMapComments(source, extension) {
  const ranges = sourceMapComments(source, extension)
  for (const [start, end] of ranges.reverse()) {
    source = source.slice(0, start) + source.slice(start, end).replace(/[^\r\n]/g, ' ') + source.slice(end)
  }
  return source
}

function walkFiles(root, visit, prefix = '') {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`[distribution] Unexpected symlink: ${relative}`)
    if (entry.isDirectory()) walkFiles(absolute, visit, relative)
    else if (entry.isFile()) visit(absolute, relative)
  }
}

function isSourceMapFile(file) {
  if (!file.endsWith('.map')) return false
  if (fs.statSync(file).size > MAX_TEXT_BYTES) throw new Error(`[distribution] Map exceeds scan limit: ${file}`)
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value?.version === 3 && (Array.isArray(value.sources) || Array.isArray(value.sections))
  } catch { return false }
}

function textFile(file) {
  return /\.(?:[cm]?js|css)$/.test(file)
}

function readText(file) {
  if (fs.statSync(file).size > MAX_TEXT_BYTES) throw new Error(`[distribution] Code exceeds bounded scan limit: ${file}`)
  return fs.readFileSync(file, 'utf8')
}

function sanitizeStaging(root) {
  let removed = 0
  let transformed = 0
  walkFiles(root, (absolute, relative) => {
    if (forbiddenPath(relative) || isSourceMapFile(absolute)) {
      fs.unlinkSync(absolute)
      removed++
    } else if (textFile(relative)) {
      const source = readText(absolute)
      const result = stripSourceMapComments(source, path.extname(relative))
      if (source !== result) {
        fs.writeFileSync(absolute, result)
        transformed++
      }
    }
  })
  return { removed, transformed }
}

function assertTree(root) {
  let files = 0
  walkFiles(root, (absolute, relative) => {
    const reason = forbiddenPath(relative) || (isSourceMapFile(absolute) ? 'source map' : null)
    if (reason) throw new Error(`[distribution] Forbidden ${reason}: ${relative}`)
    if (textFile(relative) && sourceMapComments(readText(absolute), path.extname(relative)).length) {
      throw new Error(`[distribution] Source map directive: ${relative}`)
    }
    files++
  })
  return { files }
}

module.exports = { isSourceMapFile, OUTPUT_ROOTS, RESOURCE_ROOTS, RESOURCE_FILES, forbiddenPath, sourceMapComments, stripSourceMapComments, sanitizeStaging, assertTree }
