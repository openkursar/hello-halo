import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fingerprintFile, manifestFromFiles, atomicJson } from '../../../tests/perf/build-identity/index.mjs'
import { verifyBuild } from './build.mjs'
import { execute } from './process.mjs'

const stampName = 'out/.acceptance-package.json'
const sdkPrefix = 'node_modules/@hello-halo/agent-sdk/'
const posix = value => value.split(path.sep).join('/')
const hash = value => createHash('sha256').update(value).digest('hex')
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'))

async function exists(file) {
  try { await fs.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function relativeFile(root, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Package provenance contains an invalid relative path')
  const file = path.resolve(root, name)
  if (!inside(root, file)) throw new Error('Package provenance leaves the checkout')
  return file
}

async function tree(root, directory, role, exclude = () => false, linkedRoots = []) {
  const entries = []
  const boundary = await fs.realpath(root)
  async function visit(file) {
    const name = posix(path.relative(root, file))
    if (exclude(name)) return
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(file)
      const resolved = await fs.realpath(file)
      if (path.isAbsolute(target) || ![boundary, ...linkedRoots].some(candidate => inside(candidate, resolved))) throw new Error(`Packaged or packaging-input link leaves its captured components: ${name}`)
      entries.push({ path: name, role: `${role}:link`, bytes: Buffer.byteLength(target), sha256: hash(target) })
    } else if (stat.isDirectory()) {
      for (const member of (await fs.readdir(file)).sort()) await visit(path.join(file, member))
    } else if (stat.isFile()) {
      const { path: filename, bytes, sha256 } = await fingerprintFile(file, name, role)
      entries.push({ path: filename, role: `${role}:${stat.mode & 0o111}`, bytes, sha256 })
    } else throw new Error(`Unsupported packaging member: ${name}`)
  }
  await visit(directory)
  return entries
}

function compactManifest(entries) {
  const value = manifestFromFiles(entries)
  return { count: value.count, rootSha256: value.rootSha256, files: value.files }
}

function builder(root) {
  const require = createRequire(path.join(root, 'package.json'))
  const descriptorPath = require.resolve('electron-builder/package.json')
  const descriptor = require(descriptorPath)
  const relative = typeof descriptor.bin === 'string' ? descriptor.bin : descriptor.bin?.['electron-builder']
  if (typeof relative !== 'string') throw new Error('The installed electron-builder has no CLI entry')
  const entry = path.resolve(path.dirname(descriptorPath), relative)
  if (!inside(path.dirname(descriptorPath), entry)) throw new Error('The electron-builder CLI leaves its installed package')
  return { entry, directory: path.dirname(descriptorPath), version: descriptor.version }
}

async function dependencyInputs(root) {
  const records = [], packages = [], pending = [{ directory: root, label: 'application', application: true }], visited = new Map()
  async function resolvePackage(from, name) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('An installed dependency has an invalid package name')
    const require = createRequire(path.join(from, 'package.json'))
    for (const directory of require.resolve.paths(name + '/package.json') ?? []) {
      const candidate = path.join(directory, name)
      if (await exists(path.join(candidate, 'package.json'))) return fs.realpath(candidate)
    }
    return null
  }
  while (pending.length) {
    const current = pending.shift()
    const descriptor = await readJson(path.join(current.directory, 'package.json'))
    const dependencies = { ...descriptor.peerDependencies, ...descriptor.dependencies, ...descriptor.optionalDependencies, ...(current.application ? { 'electron-builder': '*' } : {}) }
    const optional = new Set([...Object.keys(descriptor.optionalDependencies ?? {}), ...Object.keys(descriptor.peerDependenciesMeta ?? {}).filter(name => descriptor.peerDependenciesMeta[name].optional)])
    for (const name of Object.keys(dependencies).sort()) {
      const label = `${current.label}>${name}`
      const directory = await resolvePackage(current.directory, name)
      if (!directory) {
        if (!optional.has(name)) throw new Error(`Required packaging dependency is missing: ${name}`)
        records.push({ label, name, state: 'absent-optional' })
        continue
      }
      if (visited.has(directory)) { records.push({ label, name, sameAs: visited.get(directory) }); continue }
      visited.set(directory, label)
      const installed = await readJson(path.join(directory, 'package.json'))
      const record = { label, name, installedName: installed.name, version: installed.version }
      records.push(record)
      packages.push({ directory, name, record })
      pending.push({ directory, label })
    }
  }
  const linkedRoots = packages.map(item => item.directory)
  const capturedFiles = new Set(), linkedFiles = []
  for (const { directory, name, record } of packages) {
    const entries = await tree(directory, directory, 'installed-dependency', relative => {
      if (relative === '.git' || relative === 'node_modules' || relative === '.DS_Store') return true
      return name === '@hello-halo/agent-sdk' && relative !== '' && relative !== 'package.json' && relative !== 'dist' && !relative.startsWith('dist/')
    }, linkedRoots)
    for (const entry of entries) {
      const file = path.join(directory, entry.path)
      if (entry.role.endsWith(':link')) linkedFiles.push({ file, name: `${name}/${entry.path}` })
      else capturedFiles.add(file)
    }
    const content = compactManifest(entries)
    Object.assign(record, { count: content.count, contentHash: content.rootSha256 })
  }
  const capturedLinks = new Set(linkedFiles.map(link => link.file))
  async function capturedTarget(file) {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) return capturedLinks.has(file)
    if (stat.isFile()) return capturedFiles.has(file)
    if (!stat.isDirectory()) return false
    for (const member of await fs.readdir(file)) if (!await capturedTarget(path.join(file, member))) return false
    return true
  }
  for (const link of linkedFiles) if (!await capturedTarget(await fs.realpath(link.file))) throw new Error(`An installed dependency link must resolve to captured content: ${link.name}`)
  return records
}

async function packagingInputs(root, tool) {
  const entries = []
  for (const name of ['electron-builder.cjs', 'package.json', 'package-lock.json', 'product.json']) {
    const file = path.join(root, name)
    if (!await exists(file)) throw new Error(`Packaging input is missing: ${name}`)
    entries.push(...await tree(root, file, 'packaging-input'))
  }
  for (const name of ['scripts', 'resources', 'halo-local/dist']) {
    const file = path.join(root, name)
    if (await exists(file)) entries.push(...await tree(root, file, 'packaging-input', relative => relative === 'scripts/acceptance' || /(?:^|\/)(?:\.git|\.DS_Store)$/.test(relative)))
  }
  const product = await readJson(path.join(root, 'product.json'))
  for (const provider of product.authProviders ?? []) {
    if (provider.enabled === false || typeof provider.path !== 'string' || !provider.path.trim()) continue
    const name = provider.path.replace(/^\.\//, '')
    const file = relativeFile(root, name)
    if (!entries.some(entry => entry.path === name)) entries.push(...await tree(root, file, 'packaging-input'))
  }
  return { files: compactManifest(entries), builder: { version: tool.version }, dependencies: await dependencyInputs(root) }
}

function packagingEnvironment() {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GIT_CONFIG_')) environment[name] = undefined
    else if (/KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL|COOKIE|^CSC_|^WIN_CSC_|^APPLE_/i.test(name)) environment[name] = ''
  }
  return { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: 'false', HALO_MAC_SIGN_MODE: 'adhoc' }
}

async function locateApplication(root, directory) {
  const candidates = []
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory()) continue
    const output = path.join(directory, item.name)
    if (process.platform === 'darwin') {
      for (const application of await fs.readdir(output, { withFileTypes: true })) {
        if (!application.isDirectory() || !application.name.endsWith('.app')) continue
        const app = path.join(output, application.name)
        const require = createRequire(path.join(root, 'package.json'))
        const info = require('plist').parse(await fs.readFile(path.join(app, 'Contents/Info.plist'), 'utf8'))
        const name = info.CFBundleExecutable
        if (typeof name !== 'string' || path.basename(name) !== name) throw new Error('The packaged application has an invalid CFBundleExecutable')
        candidates.push({ directory: app, executable: path.join(app, 'Contents/MacOS', name), resources: path.join(app, 'Contents/Resources') })
      }
    } else if (await exists(path.join(output, 'resources/app.asar')) || await exists(path.join(output, 'resources/app'))) {
      const product = await readJson(path.join(root, 'product.json'))
      const descriptor = await readJson(path.join(root, 'package.json'))
      const platformConfig = descriptor.build?.[process.platform === 'win32' ? 'win' : 'linux']
      const configuredName = platformConfig?.executableName ?? descriptor.build?.executableName
      const require = createRequire(path.join(root, 'package.json'))
      const sanitized = require('sanitize-filename')(configuredName ?? (process.platform === 'win32' ? product.name : descriptor.name))
      const name = process.platform === 'win32' ? sanitized + '.exe' : configuredName ? sanitized : sanitized.toLowerCase()
      candidates.push({ directory: output, executable: path.join(output, name), resources: path.join(output, 'resources') })
    }
  }
  if (candidates.length !== 1) throw new Error(`Controlled packaging must produce exactly one application; found ${candidates.length}`)
  const candidate = candidates[0]
  if (!(await fs.lstat(candidate.executable)).isFile()) throw new Error('The packaged application executable is not a regular file')
  if (process.platform !== 'win32' && !((await fs.stat(candidate.executable)).mode & 0o111)) throw new Error('The packaged application entry is not executable')
  return candidate
}

async function packageReader(root, resources) {
  const archive = path.join(resources, 'app.asar')
  if (await exists(archive)) {
    const require = createRequire(path.join(root, 'package.json'))
    const asar = require('@electron/asar')
    asar.uncache(archive)
    const files = asar.listPackage(archive).map(name => posix(name.replace(/^[\\/]/, ''))).filter(name => {
      relativeFile(resources, name)
      const stat = asar.statFile(archive, name.split('/').join(path.sep), false)
      return !stat.files && !stat.link
    })
    const unpacked = archive + '.unpacked'
    for (const name of ['out', sdkPrefix.slice(0, -1)]) {
      const directory = path.join(unpacked, name)
      if (await exists(directory)) for (const file of await tree(unpacked, directory, 'unpacked-application')) if (!file.role.endsWith(':link')) files.push(file.path)
    }
    return { files: [...new Set(files)], read: async name => {
      const physical = relativeFile(unpacked, name)
      return await exists(physical) ? fs.readFile(physical) : asar.extractFile(archive, name.split('/').join(path.sep))
    } }
  }
  const application = path.join(resources, 'app')
  if (!await exists(application)) throw new Error('The packaged application has neither app.asar nor resources/app')
  const entries = await tree(application, application, 'application')
  return { files: entries.filter(entry => !entry.role.endsWith(':link')).map(entry => entry.path), read: name => fs.readFile(relativeFile(application, name)) }
}

const runtimeFile = name => !/\.(?:ts|map)$|\.(?:test|spec)\.|(?:^|\/)(?:DESIGN|VALIDATION)\.md$/.test(name)

async function packagedIdentity(root, build, application) {
  const reader = await packageReader(root, application.resources)
  const expected = build.artifacts.files.filter(file => /^out\/(?:main|preload|renderer)\//.test(file.path))
  const actualPaths = reader.files.filter(file => /^out\/(?:main|preload|renderer)\//.test(file) && path.basename(file) !== '.build-identity.json').sort()
  if (!same(actualPaths, expected.map(file => file.path).sort())) throw new Error('The packaged application does not contain exactly the controlled build outputs')
  for (const file of expected) {
    const bytes = await reader.read(file.path)
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`The packaged application differs from the controlled build: ${file.path}`)
  }
  const descriptor = await readJson(path.join(root, 'package.json'))
  const product = await readJson(path.join(root, 'product.json'))
  const packagedDescriptor = JSON.parse((await reader.read('package.json')).toString('utf8'))
  const version = product.appId === 'com.halo.experimental' ? product.version : descriptor.version
  if (packagedDescriptor.name !== descriptor.name || packagedDescriptor.version !== version || packagedDescriptor.main?.replace(/^\.\//, '') !== descriptor.main?.replace(/^\.\//, '')) throw new Error('The packaged application entry or identity differs from current packaging inputs')
  if (hash(await reader.read('product.json')) !== hash(await fs.readFile(path.join(root, 'product.json')))) throw new Error('The packaged product configuration differs from current packaging inputs')
  const sdkFiles = reader.files.filter(file => file.startsWith(sdkPrefix))
  let sdk = { state: 'absent' }
  if (build.sdk.state === 'present') {
    const directory = await fs.realpath(path.join(root, sdkPrefix))
    const installed = await readJson(path.join(directory, 'package.json'))
    const packaged = JSON.parse((await reader.read(sdkPrefix + 'package.json')).toString('utf8'))
    if (installed.name !== packaged.name || installed.version !== packaged.version) throw new Error('The packaged SDK identity differs from the controlled dependency')
    for (const field of ['main', 'module', 'type', 'exports', 'imports']) {
      if (!same(installed[field], packaged[field])) throw new Error(`The packaged SDK runtime resolution differs from the controlled dependency: ${field}`)
    }
    const distribution = await tree(directory, path.join(directory, 'dist'), 'sdk-runtime')
    const runtime = distribution.filter(file => runtimeFile(file.path))
    if (!runtime.length || distribution.some(file => file.role.endsWith(':link'))) throw new Error('The controlled SDK has no complete regular-file runtime distribution')
    const packagedPaths = sdkFiles.filter(file => file.startsWith(sdkPrefix + 'dist/')).map(file => file.slice(sdkPrefix.length)).sort()
    if (runtime.some(file => !packagedPaths.includes(file.path)) || packagedPaths.some(file => !distribution.some(source => source.path === file))) throw new Error('The packaged SDK runtime file set differs from the controlled dependency')
    const packagedRuntime = []
    for (const file of distribution.filter(file => packagedPaths.includes(file.path))) {
      const bytes = await reader.read(sdkPrefix + file.path)
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`The packaged SDK runtime differs from the controlled dependency: ${file.path}`)
      packagedRuntime.push({ path: file.path, role: 'packaged-sdk-runtime', bytes: bytes.length, sha256: hash(bytes) })
    }
    sdk = { state: 'present', version: packaged.version, sourceRevision: build.sdk.revision, sourceDirty: build.sdk.dirty, sourceDist: build.sdk.dist, packagedRuntime: compactManifest(packagedRuntime) }
  } else if (sdkFiles.length) throw new Error('The package contains an SDK absent from the controlled build')
  return { name: packagedDescriptor.name, version: packagedDescriptor.version, main: packagedDescriptor.main, sdk }
}

function buildIdentity(build) {
  return { id: build.id, inputsHash: build.inputs.rootSha256, artifactsHash: build.artifacts.rootSha256, sdk: build.sdk }
}

export async function packageApplication(root, { timeoutMs = 1800000 } = {}) {
  root = await fs.realpath(root)
  const stamp = path.join(root, stampName)
  await fs.rm(stamp, { force: true })
  const build = await verifyBuild(root)
  if (!['darwin', 'win32', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error('Controlled packaging does not support this host platform or architecture')
  const tool = builder(root)
  const before = await packagingInputs(root, tool)
  const id = randomUUID()
  const output = path.join(root, 'tests/acceptance/output/packages', id)
  await fs.mkdir(output, { recursive: true })
  if (!inside(root, await fs.realpath(output))) throw new Error('The controlled package output leaves the checkout')
  const platform = { darwin: '--mac', win32: '--win', linux: '--linux' }[process.platform]
  // Directory-only targets omit updater configuration on desktop platforms.
  const target = { darwin: 'zip', win32: 'nsis', linux: 'AppImage' }[process.platform]
  const args = [tool.entry, platform, target, '--' + process.arch, '--config', 'electron-builder.cjs', '--publish', 'never', '-c.directories.output=' + posix(path.relative(root, output)), '-c.forceCodeSigning=false']
  if (process.platform === 'darwin') args.push('-c.mac.identity=null', '-c.mac.notarize=false')
  if (process.platform === 'win32') args.push('-c.win.signAndEditExecutable=false')
  console.log('acceptance: packaging the verified application for local testing without publishing')
  const logFile = path.join(output, 'package.log')
  const result = await execute(root, args, { timeoutMs, logFile, environment: packagingEnvironment() })
  if (result.code !== 0 || result.timedOut || result.cleanupFailed) throw new Error(`Controlled packaging did not complete successfully; see tests/acceptance/output/packages/${id}/package.log`)
  if (!same(buildIdentity(build), buildIdentity(await verifyBuild(root))) || !same(before, await packagingInputs(root, tool))) throw new Error('Build or packaging inputs changed during packaging; no package provenance was recorded')
  const application = await locateApplication(root, output)
  const content = compactManifest(await tree(application.directory, application.directory, 'package-content'))
  const identity = await packagedIdentity(root, build, application)
  if (!same(buildIdentity(build), buildIdentity(await verifyBuild(root))) || !same(before, await packagingInputs(root, tool))) throw new Error('Build or packaging inputs changed while recording the package')
  const record = { version: 1, id, packagedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, command: ['electron-builder', ...args.slice(1)], signing: process.platform === 'darwin' ? 'local-adhoc' : 'unsigned', build: buildIdentity(build), inputs: before, directory: posix(path.relative(root, application.directory)), executable: posix(path.relative(root, application.executable)), resources: posix(path.relative(root, application.resources)), content, application: identity, coverage: 'Directory package provenance: controlled application/SDK byte identity and the complete emitted bundle fingerprint. Other dependency behavior, installer flows, operating-system consent, distribution signing and notarization require separate execution checks.' }
  atomicJson(stamp, record)
  return record
}

export async function verifyPackagedApplication(root, executablePath) {
  root = await fs.realpath(root)
  let record
  try { record = await readJson(path.join(root, stampName)) }
  catch (error) { if (error.code === 'ENOENT') throw new Error('No controlled acceptance package exists; run acceptance package first'); throw error }
  if (record.version !== 1 || record.platform !== process.platform || record.architecture !== process.arch) throw new Error('The package provenance is unsupported or belongs to another platform')
  const directory = relativeFile(root, record.directory)
  const executable = relativeFile(root, record.executable)
  const resources = relativeFile(root, record.resources)
  if (!inside(root, await fs.realpath(directory)) || !inside(directory, executable) || !inside(directory, resources)) throw new Error('The recorded package paths leave the controlled package')
  if (typeof executablePath !== 'string' || !executablePath || await fs.realpath(path.resolve(root, executablePath)) !== await fs.realpath(executable)) throw new Error('The requested executable is not the controlled acceptance package')
  const build = await verifyBuild(root)
  if (!same(record.build, buildIdentity(build))) throw new Error('The package belongs to a different controlled build')
  if (!same(record.inputs, await packagingInputs(root, builder(root)))) throw new Error('Packaging inputs changed after the controlled package was created')
  const content = compactManifest(await tree(directory, directory, 'package-content'))
  if (!same(content, record.content)) throw new Error('Packaged application content changed after controlled packaging')
  if (!same(record.application, await packagedIdentity(root, build, { directory, executable, resources }))) throw new Error('Packaged application or SDK identity changed after controlled packaging')
  if (!same(record.build, buildIdentity(await verifyBuild(root))) || !same(record.inputs, await packagingInputs(root, builder(root)))) throw new Error('Build or packaging inputs changed while verifying the package')
  return record
}
