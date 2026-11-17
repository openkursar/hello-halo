import { constants } from 'node:fs'
import { access, lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize, delimiter } from 'node:path'
import { homedir } from 'node:os'
import type { ResolvedCandidate, RuntimeProvider } from '../../provider'
import { RuntimeError } from '../../errors'
import { CODEX_PLATFORMS, requiredComponents, type CodexPlatform } from './policy'

export function getCodexPlatform(): CodexPlatform {
  const platform = `${process.platform}-${process.arch}`
  if (!(platform in CODEX_PLATFORMS)) throw new RuntimeError('unsupported-platform')
  return platform as CodexPlatform
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) console.warn('[CodexRuntime] Candidate stat failed', { code: (error as NodeJS.ErrnoException).code })
    return false
  }
}

async function stamp(path: string): Promise<string> {
  const link = await lstat(path)
  const target = await realpath(path)
  const info = await stat(target)
  if (!info.isFile()) throw new RuntimeError('not-executable')
  return `${path}:${link.ino}:${link.mtimeMs}:${link.ctimeMs}:${target}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}

export async function resolveCodexCandidate(input: string): Promise<ResolvedCandidate> {
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\0')) throw new RuntimeError('not-found')
  let path = input.trim().replace(/^(["'])(.*)\1$/, '$2')
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
  if (!isAbsolute(path)) throw new RuntimeError('not-found')
  path = normalize(path)
  const displayPath = path
  const platform = getCodexPlatform()
  const required = requiredComponents(platform)
  const info = await stat(path).catch(() => { throw new RuntimeError('not-found') })
  const initialTarget = await realpath(path)
  const roots = info.isDirectory() ? [path] : [dirname(initialTarget), dirname(dirname(initialTarget)), dirname(path)]
  const packages = roots.flatMap(root => [
    root,
    join(root, 'node_modules/@openai/codex'),
    join(root, 'lib/node_modules/@openai/codex'),
    join(root, `node_modules/@openai/codex-${platform}`),
    join(root, `node_modules/@openai/codex/node_modules/@openai/codex-${platform}`),
    ...(basename(root) === 'codex' && basename(dirname(root)) === '@openai'
      ? [join(dirname(root), `codex-${platform}`)] : []),
  ])
  let root: string | undefined
  if (!info.isDirectory() && !['.js', '.mjs', '.cjs', '.cmd', '.bat', '.ps1'].includes(extname(initialTarget).toLowerCase())) {
    const nativeRoot = dirname(dirname(dirname(dirname(initialTarget))))
    if (await exists(join(nativeRoot, required[0])) && await realpath(join(nativeRoot, required[0])) === initialTarget) root = nativeRoot
  }
  if (!root) for (const candidate of packages) if (await exists(join(candidate, required[0]))) { root = candidate; break }
  if (!root) throw new RuntimeError('unsupported-launcher')
  const executable = join(root, required[0])
  const resolvedPath = await realpath(executable)
  const handle = await open(resolvedPath, 'r')
  const header = Buffer.alloc(4)
  try { await handle.read(header, 0, 4, 0) } finally { await handle.close() }
  const magic = header.readUInt32BE()
  if (![0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic) && header.subarray(0, 2).toString() !== 'MZ') throw new RuntimeError('unsupported-launcher')
  const stamps = info.isFile() ? [await stamp(displayPath)] : []
  for (const component of required) {
    const componentPath = join(root, component)
    stamps.push(await stamp(componentPath))
    if (process.platform !== 'win32') await access(componentPath, constants.X_OK).catch(() => { throw new RuntimeError('not-executable') })
  }
  return { path: displayPath, resolvedPath, stamp: stamps.join('|'), launch: { path: displayPath, command: resolvedPath, argsPrefix: [], env: {}, kind: 'native', pathDirs: [join(root, `vendor/${CODEX_PLATFORMS[platform].triple}/path`)] } }
}

export const discoverCodexCandidates: RuntimeProvider['discoveryCandidates'] = async context => {
  const paths = new Set<string>()
  if (context.selectedPath) paths.add(context.selectedPath)
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const pathEntries = (process.env.PATH || process.env.Path || '').split(delimiter).filter(isAbsolute)
  let truncated = pathEntries.length > 32
  for (const directory of pathEntries.slice(0, 32)) {
    if (context.signal.aborted) throw new RuntimeError('cancelled')
    for (const name of [binary, 'codex.cmd']) if (await exists(join(directory, name))) paths.add(join(directory, name))
  }
  const platform = getCodexPlatform()
  const roots = [join(homedir(), '.npm-global'), '/usr/local', '/opt/homebrew', join(homedir(), 'AppData/Roaming/npm')]
  for (const root of roots) for (const suffix of [
    'bin/codex', 'codex.cmd',
    `lib/node_modules/@openai/codex-${platform}/${requiredComponents(platform)[0]}`,
    `lib/node_modules/@openai/codex/${requiredComponents(platform)[0]}`,
  ]) {
    if (context.signal.aborted) throw new RuntimeError('cancelled')
    const path = join(root, suffix)
    if (await exists(path)) paths.add(path)
  }
  for (const parent of [context.root, join(homedir(), '.nvm/versions/node'), join(homedir(), '.fnm/node-versions'), join(homedir(), '.volta/tools/image/node')]) {
    if (context.signal.aborted) throw new RuntimeError('cancelled')
    const children = await context.childDirectories(parent, 24)
    truncated ||= children.truncated
    for (const child of children.paths) {
      if (parent === context.root) paths.add(child)
      else for (const suffix of ['bin/codex', 'installation/bin/codex']) if (await exists(join(child, suffix))) paths.add(join(child, suffix))
    }
  }
  return { paths: [...paths].slice(0, 128), truncated: truncated || paths.size > 128 }
}
