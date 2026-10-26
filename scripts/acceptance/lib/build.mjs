import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { fingerprintFile, manifestFromFiles, gitCatalogue, atomicJson } from '../../../tests/perf/build-identity/index.mjs'
import { execute } from './process.mjs'

const stampName = 'out/.acceptance-build.json'
const lockName = 'out/.acceptance-build.lock'
const generatedResources = ['resources/api-ref', 'resources/builtin-apps', 'resources/office-runtime', 'resources/dsh-runtime']
const generatedOutputs = ['out/main', 'out/preload', 'out/renderer', ...generatedResources]
const posix = value => value.split(path.sep).join('/')
const inside = (parent, child) => { const value = path.relative(parent, child); return value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value) }
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function exists(file) {
  try { await fs.access(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function walk(directory, exclude = () => false, base = directory, ancestors = new Set()) {
  const actual = await fs.realpath(directory)
  if (ancestors.has(actual)) throw new Error('Build identity found a cyclic directory link')
  const chain = new Set([...ancestors, actual])
  const result = []
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name)
    if (exclude(file, entry)) continue
    const stat = await fs.stat(file)
    if (entry.isSymbolicLink() && !inside(await fs.realpath(base), await fs.realpath(file))) throw new Error(`Build component link leaves its directory: ${entry.name}`)
    if (stat.isDirectory()) result.push(...await walk(file, exclude, base, chain))
    else if (stat.isFile()) result.push(file)
    else throw new Error(`Build identity cannot follow a symbolic or special file: ${entry.name}`)
  }
  return result
}

async function manifest(root, files, role) {
  const entries = []
  for (const file of [...new Set(files)].sort()) entries.push(await fingerprintFile(file, posix(path.relative(root, file)), role))
  const value = manifestFromFiles(entries)
  return { count: value.count, rootSha256: value.rootSha256, files: value.files.map(({ path, role, bytes, sha256 }) => ({ path, role, bytes, sha256 })) }
}

async function productInputs(root) {
  const descriptor = await readJson(path.join(root, 'package.json'))
  if (typeof descriptor.scripts?.build !== 'string') throw new Error('The application has no npm build command')
  const known = gitCatalogue(root)
  const selected = new Set(known.filter(file => {
    if (file === 'src/sdk' || file.startsWith('src/sdk/') || generatedResources.some(directory => file === directory || file.startsWith(directory + '/'))) return false
    if (/^(?:src|resources|patches|runtimes)\//.test(file)) return !/(?:^|\/)(?:node_modules|dist|out|\.git|__tests__|docs)(?:\/|$)|(?:^|\/)(?:README|DESIGN|ARCHITECTURE)\.md$|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    return /^(?:package(?:-lock)?\.json|yarn\.lock|\.npmrc|\.nvmrc|\.node-version|(?:electron|vite|tsconfig|tailwind|postcss)[^/]*\.(?:[cm]?[jt]s|json))$/.test(file) || file === 'product.json'
  }))
  selected.add('package.json')
  selected.add('package-lock.json')
  selected.add('product.json')
  const commands = ['build'], visitedCommands = new Set(), pending = []
  while (commands.length) {
    const name = commands.pop()
    if (visitedCommands.has(name)) continue
    visitedCommands.add(name)
    for (const hook of [name, `pre${name}`, `post${name}`]) {
      const command = descriptor.scripts[hook]
      if (!command) continue
      for (const match of command.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)) commands.push(match[1])
      for (const match of command.matchAll(/(?:^|\s)(?:node|bash|sh|python3?)\s+['"]?([^\s'";&|]+\.(?:mjs|cjs|js|ts|sh|py))/g)) pending.push(path.resolve(root, match[1]))
    }
  }
  pending.push(...[...selected].filter(file => /\.[cm]?[jt]s$/.test(file) && !file.startsWith('src/')).map(file => path.join(root, file)))
  const visitedFiles = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (!inside(root, file)) throw new Error('Build tooling refers to code outside the source checkout')
    if (visitedFiles.has(file)) continue
    visitedFiles.add(file)
    selected.add(posix(path.relative(root, file)))
    const source = await fs.readFile(file, 'utf8')
    const dependencies = []
    if (/\.[cm]?[jt]s$/.test(file)) {
      const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS)
      const collect = node => {
        let specifier
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier = node.moduleSpecifier
        else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) specifier = node.arguments[0]
        if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) dependencies.push(specifier.text)
        ts.forEachChild(node, collect)
      }
      collect(syntax)
    }
    for (const dependency of dependencies) {
      const base = path.resolve(path.dirname(file), dependency)
      const candidates = [base, base.replace(/\.js$/, '.ts'), ...['.mjs', '.cjs', '.js', '.ts', '/index.mjs', '/index.ts'].map(extension => base + extension)]
      let found
      for (const candidate of candidates) if (await exists(candidate) && (await fs.stat(candidate)).isFile()) { found = candidate; break }
      if (!found) throw new Error(`Build dependency is missing for ${posix(path.relative(root, file))}`)
      pending.push(found)
    }
  }
  const files = []
  for (const name of [...selected].sort()) {
    const file = path.join(root, name)
    if (await exists(file)) {
      if (!(await fs.lstat(file)).isFile()) throw new Error(`Product input must be a regular file: ${name}`)
      files.push(file)
    } else if (['package.json', 'package-lock.json', 'product.json'].includes(name) || visitedFiles.has(file)) throw new Error(`Required build input is missing: ${name}`)
  }
  if (!files.some(file => posix(path.relative(root, file)).startsWith('src/'))) throw new Error('No product source files were found')
  return manifest(root, files, 'product-input')
}

async function sdkSnapshot(root) {
  const packageDirectory = path.join(root, 'node_modules/@hello-halo/agent-sdk')
  if (!await exists(path.join(packageDirectory, 'package.json'))) return { state: 'absent' }
  const directory = await fs.realpath(packageDirectory)
  const descriptor = await readJson(path.join(directory, 'package.json'))
  if (descriptor.name !== '@hello-halo/agent-sdk') throw new Error('The installed SDK package identity is invalid')
  let revision = null, dirty = null, sourceCheckout = false
  try {
    if (await fs.realpath(git(directory, ['rev-parse', '--show-toplevel'])) === directory) {
      sourceCheckout = true
      revision = git(directory, ['rev-parse', 'HEAD'])
      dirty = Boolean(git(directory, ['status', '--porcelain', '--untracked-files=normal']))
    }
  } catch {
    // An installed distribution can lack Git metadata; its content remains explicit, never a clean source claim.
  }
  let sourceFiles
  if (sourceCheckout) {
    sourceFiles = []
    for (const name of gitCatalogue(directory)) {
      if (/^(?:dist|node_modules)\//.test(name)) continue
      const file = path.join(directory, name)
      if (!await exists(file)) continue
      if (!(await fs.lstat(file)).isFile()) throw new Error('SDK source checkout contains an unsupported symbolic or special input')
      sourceFiles.push(file)
    }
  } else {
    sourceFiles = await walk(directory, (file, entry) => {
      const relative = posix(path.relative(directory, file))
      return relative === '.git' || relative === 'dist' || relative === 'node_modules' || relative === '.build-identity.json' || (entry.isDirectory() && ['docs', 'validation', 'swe-bench-eval'].includes(entry.name))
    })
  }
  const source = await manifest(directory, sourceFiles, 'sdk-source')
  const distDirectory = path.join(directory, 'dist')
  const distFiles = await exists(distDirectory) ? await walk(distDirectory) : []
  const dist = distFiles.length ? await manifest(directory, distFiles, 'sdk-dist') : null
  return { state: 'present', version: descriptor.version, revision, dirty, provenance: revision ? 'source-checkout' : 'distribution-without-revision', source: { count: source.count, rootSha256: source.rootSha256 }, dist: dist ? { count: dist.count, rootSha256: dist.rootSha256 } : null }
}

async function artifacts(root) {
  const descriptor = await readJson(path.join(root, 'package.json'))
  const main = path.resolve(root, descriptor.main ?? '')
  if (!inside(path.join(root, 'out/main'), main) || !await exists(main) || !(await fs.stat(main)).isFile()) throw new Error('The declared application main entry was not built under out/main')
  const files = []
  for (const component of ['main', 'preload', 'renderer']) {
    const directory = path.join(root, 'out', component)
    if (!await exists(directory)) throw new Error(`The ${component} output directory is missing`)
    const members = await walk(directory, file => path.basename(file) === '.build-identity.json')
    if (!members.length) throw new Error(`The ${component} output is empty`)
    if (component === 'preload' && !members.some(file => /^index\.[cm]?js$/.test(path.basename(file)))) throw new Error('The preload entry is missing')
    if (component === 'renderer' && !members.some(file => path.basename(file) === 'index.html')) throw new Error('The renderer entry is missing')
    files.push(...members)
  }
  for (const directory of generatedResources) if (await exists(path.join(root, directory))) files.push(...await walk(path.join(root, directory)))
  return manifest(root, files, 'application-output')
}

async function prepareProductConfig(root) {
  const product = await readJson(path.join(root, 'product.json'))
  const directory = path.join(root, 'out/main')
  for (const provider of product.authProviders ?? []) {
    if (typeof provider.path === 'string' && provider.path.startsWith('./')) provider.path = path.relative(directory, path.resolve(root, provider.path))
  }
  await fs.writeFile(path.join(directory, 'product.json'), JSON.stringify(product, null, 2))
}

async function snapshot(root) {
  return { inputs: await productInputs(root), sdk: await sdkSnapshot(root) }
}

export async function buildApplication(root, { timeoutMs = 1800000 } = {}) {
  root = await fs.realpath(root)
  for (const directory of ['out', 'resources']) {
    const location = path.join(root, directory)
    if (await exists(location) && !(await fs.lstat(location)).isDirectory()) throw new Error(`The ${directory} build directory must not be a symbolic link`)
  }
  await fs.mkdir(path.join(root, 'out'), { recursive: true })
  const lock = path.join(root, lockName)
  try { await fs.mkdir(lock) }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`A controlled build already owns ${lockName}; confirm its recorded process has stopped before removing a stale lock`)
    throw error
  }
  try {
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    return await buildOwnedApplication(root, timeoutMs)
  } finally {
    await fs.rm(lock, { recursive: true, force: true })
  }
}

async function buildOwnedApplication(root, timeoutMs) {
  const before = await snapshot(root)
  const file = path.join(root, stampName)
  await fs.rm(file, { force: true })
  for (const directory of generatedOutputs) await fs.rm(path.join(root, directory), { recursive: true, force: true })
  const id = randomUUID()
  const logFile = path.join(root, 'tests/acceptance/output/builds', `${id}.log`)
  console.log('acceptance: building the application from captured product inputs')
  const result = await execute(root, ['run', 'build'], { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', shell: process.platform === 'win32', timeoutMs, logFile })
  if (result.code !== 0 || result.timedOut || result.cleanupFailed) throw new Error(`Application build did not complete successfully; see tests/acceptance/output/builds/${id}.log`)
  const after = await snapshot(root)
  if (before.inputs.rootSha256 !== after.inputs.rootSha256 || !same(before.sdk, after.sdk)) throw new Error('Product inputs or SDK changed during the build; no build provenance was recorded')
  if (!await exists(path.join(root, 'out/main'))) throw new Error('The main output directory is missing after the build')
  await prepareProductConfig(root)
  const output = await artifacts(root)
  const finalInputs = await snapshot(root)
  if (after.inputs.rootSha256 !== finalInputs.inputs.rootSha256 || !same(after.sdk, finalInputs.sdk)) throw new Error('Product inputs or SDK changed while recording the build')
  const record = { version: 2, id, builtAt: new Date().toISOString(), command: ['npm', 'run', 'build'], cleanedOutputs: generatedOutputs, platform: process.platform, architecture: process.arch, node: process.versions.node, inputs: after.inputs, sdk: after.sdk, artifacts: output, configuration: 'out/main/product.json is prepared with the same relative-provider paths as the Electron test fixture' }
  atomicJson(file, record)
  return record
}

export async function verifyBuild(root) {
  root = await fs.realpath(root)
  if (await exists(path.join(root, lockName))) throw new Error('A controlled build is still in progress; its output cannot be used yet')
  let record
  try { record = await readJson(path.join(root, stampName)) }
  catch (error) { if (error.code === 'ENOENT') throw new Error('No controlled acceptance build exists; run acceptance build first'); throw error }
  if (record.version !== 2 || !same(record.command, ['npm', 'run', 'build']) || !same(record.cleanedOutputs, generatedOutputs)) throw new Error('The acceptance build provenance is unsupported; rebuild from clean outputs')
  if (record.platform !== process.platform || record.architecture !== process.arch) throw new Error('The application was built for a different platform or architecture')
  const current = await snapshot(root)
  if (current.inputs.rootSha256 !== record.inputs?.rootSha256) throw new Error('Product inputs changed after the controlled build; rebuild before testing')
  if (!same(current.sdk, record.sdk)) throw new Error('SDK source, revision or compiled distribution changed after the controlled build')
  const output = await artifacts(root)
  if (output.rootSha256 !== record.artifacts?.rootSha256) throw new Error('Application build output changed after the controlled build')
  return record
}
