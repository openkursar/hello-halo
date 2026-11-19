'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { forbiddenPath, isSourceMapFile, stripSourceMapComments, OUTPUT_ROOTS, RESOURCE_ROOTS, RESOURCE_FILES } = require('./distribution-policy.cjs')

function prepareDistributionStaging(root, providerFiles = [], declaredDirectories = []) {
  root = fs.realpathSync(root)
  const providers = new Set(providerFiles)
  const productionPackages = new Set()
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  function collect(name, parent, optional = false) {
    let current = parent
    let directory
    while (current.startsWith(root)) {
      const candidate = path.join(current, 'node_modules', name)
      if (fs.existsSync(path.join(candidate, 'package.json'))) { directory = candidate; break }
      const next = path.dirname(current)
      if (next === current) break
      current = next
    }
    if (!directory) {
      if (!optional) throw new Error(`[distribution] Missing production dependency: ${name}`)
      return
    }
    if (productionPackages.has(directory)) return
    productionPackages.add(directory)
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(metadata.dependencies || {})) collect(dependency, directory, Boolean(metadata.optionalDependencies?.[dependency]))
    for (const dependency of Object.keys({ ...metadata.optionalDependencies, ...metadata.peerDependencies })) collect(dependency, directory, true)
  }
  for (const name of Object.keys(manifest.dependencies || {})) collect(name, root)
  for (const name of Object.keys(manifest.optionalDependencies || {})) collect(name, root, true)
  const allowed = relative => {
    if (forbiddenPath(relative)) return false
    if (declaredDirectories.some(dir => relative.startsWith(`${dir}/`))) return true
    if (relative.startsWith('node_modules/')) return !relative.split('/').includes('.bin')
    if (relative.startsWith('out/')) return OUTPUT_ROOTS.some(dir => relative.startsWith(dir))
    if (relative.startsWith('resources/')) {
      const resource = relative.slice('resources/'.length)
      return RESOURCE_ROOTS.some(dir => resource.startsWith(dir)) || RESOURCE_FILES.includes(resource)
    }
    return relative === 'package.json' || relative === 'product.json' || providers.has(relative) || relative.startsWith('halo-local/dist/')
  }
  function copy(source, destination, relative, ancestors = new Set()) {
    const real = fs.realpathSync(source)
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error(`[distribution] Source escapes project: ${relative}`)
    if (ancestors.has(real)) throw new Error(`[distribution] Symlink cycle: ${relative}`)
    const lineage = new Set(ancestors).add(real)
    const stat = fs.statSync(source)
    if (stat.isDirectory()) {
      if (relative === 'node_modules/@parcel/watcher/build' && ['watcher-darwin-arm64', 'watcher-darwin-x64', 'watcher-linux-x64-glibc', 'watcher-win32-x64'].some(name => fs.existsSync(path.join(root, 'node_modules/@parcel', name, 'watcher.node')))) return
      const parent = path.dirname(source)
      const packageRoot = path.basename(parent) === 'node_modules' || (path.basename(parent).startsWith('@') && path.basename(path.dirname(parent)) === 'node_modules')
      if (relative.startsWith('node_modules/') && packageRoot && fs.existsSync(path.join(source, 'package.json')) && !productionPackages.has(source)) return
      if (relative && relative !== 'out' && forbiddenPath(`${relative}/package.json`)) return
      if (relative.startsWith('out/') && !OUTPUT_ROOTS.some(dir => dir.startsWith(`${relative}/`) || relative.startsWith(dir))) return
      if (relative.startsWith('resources/') && !declaredDirectories.some(dir => relative === dir || relative.startsWith(`${dir}/`) || dir.startsWith(`${relative}/`)) && !RESOURCE_ROOTS.some(dir => `resources/${dir}`.startsWith(`${relative}/`) || relative.startsWith(`resources/${dir}`))) return
      for (const name of fs.readdirSync(source)) {
        if (name === '.bin') continue
        copy(path.join(source, name), path.join(destination, name), relative ? `${relative}/${name}` : name, lineage)
      }
    } else if (stat.isFile() && allowed(relative) && !isSourceMapFile(source)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      if (/\.(?:[cm]?js|css)$/.test(relative)) {
        if (stat.size > 128 * 1024 * 1024) throw new Error(`[distribution] Code exceeds staging limit: ${relative}`)
        fs.writeFileSync(destination, stripSourceMapComments(fs.readFileSync(source, 'utf8'), path.extname(relative)), { mode: stat.mode })
      } else {
        fs.copyFileSync(source, destination)
        fs.chmodSync(destination, stat.mode)
      }
    }
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-distribution-'))
  try {
    for (const name of ['package.json', 'product.json', 'out', 'resources', 'node_modules', 'halo-local']) {
      if (fs.existsSync(path.join(root, name))) copy(path.join(root, name), path.join(stage, name), name)
    }
    for (const directory of declaredDirectories) {
      const source = path.resolve(root, directory)
      if (!source.startsWith(`${root}${path.sep}`)) throw new Error('[distribution] Declared resource escapes project')
      copy(source, path.join(stage, directory), directory)
    }
    for (const provider of providers) {
      const source = path.resolve(root, provider)
      if (source !== root && !source.startsWith(`${root}${path.sep}`)) throw new Error('[distribution] Provider path escapes project')
      if (!fs.existsSync(source)) throw new Error(`[distribution] Missing provider: ${provider}`)
      copy(source, path.join(stage, provider), provider)
    }
    const applicationManifest = { ...manifest }
    delete applicationManifest.build
    delete applicationManifest.devDependencies
    delete applicationManifest.scripts
    fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(applicationManifest, null, 2)}\n`)
    return stage
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

module.exports = { prepareDistributionStaging }
