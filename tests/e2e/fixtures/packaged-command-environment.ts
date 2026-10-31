import fs from 'node:fs'
import path from 'node:path'

export type HostCommandPolicy = 'inherit' | 'system-only'

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
}

export function packagedCommandEnvironment(source: NodeJS.ProcessEnv, policy: HostCommandPolicy, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const environment = { ...source }
  if (policy === 'inherit') return environment
  const cleared = new Set(['PATH', 'NODE_PATH', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'SHELL', 'AGENT_SHELL', 'AGENT_GIT_BASH_PATH', 'CLAUDE_CODE_GIT_BASH_PATH'])
  for (const key of Object.keys(environment)) if (cleared.has(key.toUpperCase())) delete environment[key]
  if (platform === 'win32') {
    const root = environmentValue(source, 'SystemRoot') ?? environmentValue(source, 'WINDIR')
    if (!root || !path.win32.isAbsolute(root)) throw new Error('The system-only packaged fixture requires an absolute Windows SystemRoot')
    for (const key of Object.keys(environment)) if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())) delete environment[key]
    environment.SystemRoot = root
    environment.WINDIR = root
    environment.ComSpec = path.win32.join(root, 'System32', 'cmd.exe')
    environment.PATHEXT = '.COM;.EXE;.BAT;.CMD'
    environment.PATH = [path.win32.join(root, 'System32'), root, path.win32.join(root, 'System32', 'Wbem'), path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
  } else if (platform === 'darwin' || platform === 'linux') {
    environment.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  } else throw new Error(`Unsupported system-only packaged host: ${platform}`)
  return environment
}

export interface PackagedCommandRuntime {
  platform: NodeJS.Platform
  cwd: string
  commandPath: string | undefined
  appPath: string
  resources: string
  userData: string
  profile: string
  execPath: string
}

export interface CommandOrigin {
  requestedPath: string | null
  resolvedPath: string | null
  origin: 'package' | 'generated-shim' | 'external' | 'missing' | 'unverified'
  errorCode?: string
}

export function packageDirectory(runtime: PackagedCommandRuntime): string {
  return runtime.platform === 'darwin' ? path.resolve(runtime.resources, '..', '..') : path.dirname(runtime.resources)
}

function within(directory: string, file: string): boolean {
  const difference = path.relative(fs.realpathSync(directory), file)
  return difference === '' || (!difference.startsWith(`..${path.sep}`) && difference !== '..' && !path.isAbsolute(difference))
}

export function nativeCommandPath(value: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') {
    const drive = value.match(/^\/([A-Za-z])\/(.*)$/)
    if (drive) return `${drive[1]}:/${drive[2]}`
    if (/^\/[A-Za-z]:\//.test(value)) return value.slice(1)
    return path.win32.isAbsolute(value) ? value : null
  }
  return path.posix.isAbsolute(value) ? value : null
}

export function commandOrigin(value: string | null, runtime: PackagedCommandRuntime, allowShim = false): CommandOrigin {
  if (!value) return { requestedPath: value, resolvedPath: null, origin: 'missing' }
  const native = nativeCommandPath(value, runtime.platform)
  if (!native) return { requestedPath: value, resolvedPath: null, origin: 'unverified', errorCode: 'NON_ABSOLUTE_COMMAND' }
  try {
    const real = fs.realpathSync(native)
    if (!fs.statSync(real).isFile()) return { requestedPath: value, resolvedPath: real, origin: 'unverified', errorCode: 'NOT_A_FILE' }
    if (within(packageDirectory(runtime), real)) return { requestedPath: value, resolvedPath: real, origin: 'package' }
    if (allowShim && within(runtime.profile, fs.realpathSync(runtime.userData))) {
      const shim = path.join(runtime.userData, 'office-runtime', 'bin')
      if (fs.existsSync(shim)) {
        const realShim = fs.realpathSync(shim)
        if (within(runtime.userData, realShim) && within(runtime.userData, real) && within(realShim, real) && ['halo-node', 'halo-node.cmd'].includes(path.basename(real))) return { requestedPath: value, resolvedPath: real, origin: 'generated-shim' }
      }
    }
    return { requestedPath: value, resolvedPath: real, origin: 'external' }
  } catch (error) {
    return { requestedPath: value, resolvedPath: null, origin: 'unverified', errorCode: (error as NodeJS.ErrnoException).code ?? 'PATH_CHECK_FAILED' }
  }
}

function resolveHostCommand(name: string, runtime: PackagedCommandRuntime): CommandOrigin {
  if (runtime.commandPath === undefined) return { requestedPath: null, resolvedPath: null, origin: 'unverified', errorCode: 'PATH_UNAVAILABLE' }
  const directories = runtime.commandPath.split(path.delimiter)
  // Node's Windows executable lookup also considers its current directory.
  if (runtime.platform === 'win32') directories.unshift(runtime.cwd)
  for (const directory of directories) {
    const root = path.resolve(runtime.cwd, directory)
    for (const candidate of runtime.platform === 'win32' ? [`${name}.com`, `${name}.exe`, name] : [name]) {
      const file = path.join(root, candidate)
      try {
        fs.accessSync(file, runtime.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
        if (fs.statSync(file).isFile()) return commandOrigin(file, runtime)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(code ?? '')) return { requestedPath: file, resolvedPath: null, origin: 'unverified', errorCode: code ?? 'PATH_CHECK_FAILED' }
      }
    }
  }
  return { requestedPath: null, resolvedPath: null, origin: 'missing' }
}

export function inspectHostCommands(runtime: PackagedCommandRuntime) {
  const rg = resolveHostCommand('rg', runtime)
  return { runtime, rg, node: resolveHostCommand('node', runtime), hostRgExcluded: ['missing', 'package'].includes(rg.origin) }
}

function marker(output: string, prefix: string): string | null {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(prefix))
  return lines.length === 1 ? lines[0].slice(prefix.length).trim() || null : null
}

function literalShellWord(input: string): string | null {
  if (!input || /[\0\r\n$`]/.test(input)) return null
  let quote: "'" | '"' | null = null
  let value = ''
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (quote === "'") {
      if (character === "'") quote = null
      else value += character
    } else if (character === '\\') {
      const next = input[++index]
      if (!next || !(quote === '"' ? /["\\]/ : /[\s'"\\]/).test(next)) return null
      value += next
    } else if (quote === '"') {
      if (character === '"') quote = null
      else value += character
    } else if (character === "'" || character === '"') {
      quote = character
    } else {
      if (/[\s;&|<>(){}*?\[\]~!^]/.test(character)) return null
      value += character
    }
  }
  return quote === null ? value : null
}

function rgCommandOrigin(reported: string | null, runtime: PackagedCommandRuntime): CommandOrigin {
  const prefix = 'alias rg='
  if (!reported?.startsWith(prefix)) return commandOrigin(reported, runtime)
  // command -v quotes an alias definition. Its decoded expansion must itself be one literal path word.
  const expansion = literalShellWord(reported.slice(prefix.length))
  const target = expansion === null ? null : literalShellWord(expansion)
  if (!target || !nativeCommandPath(target, runtime.platform)) return { requestedPath: reported, resolvedPath: null, origin: 'unverified', errorCode: 'INVALID_RG_ALIAS' }
  return { ...commandOrigin(target, runtime), requestedPath: reported }
}

function officeLibrary(value: unknown, runtime: PackagedCommandRuntime): CommandOrigin {
  const result = commandOrigin(typeof value === 'string' ? value : null, runtime)
  if (result.origin !== 'package' || !result.resolvedPath) return result
  const directory = path.join(runtime.resources, 'office-runtime', 'node_modules')
  return fs.existsSync(directory) && within(directory, result.resolvedPath) ? result : { ...result, origin: 'external' as const }
}

export function inspectPackagedToolOrigins(rgOutput: string, officeOutput: string, runtime: PackagedCommandRuntime) {
  const rg = rgCommandOrigin(marker(rgOutput, 'ACCEPTANCE_RG_PATH='), runtime)
  const shim = commandOrigin(marker(officeOutput, 'ACCEPTANCE_OFFICE_SHIM='), runtime, true)
  let office: Record<string, unknown> = {}
  let parseError: string | undefined
  try {
    const value = JSON.parse(marker(officeOutput, 'ACCEPTANCE_OFFICE_ORIGIN=') ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing Office runtime origin')
    office = value
  } catch { parseError = 'The real Office command did not return one valid origin record' }
  const executable = commandOrigin(typeof office.execPath === 'string' ? office.execPath : null, runtime)
  const libraries = { exceljs: officeLibrary(office.exceljs, runtime), docx: officeLibrary(office.docx, runtime) }
  const verified = !parseError && rg.origin === 'package' && ['package', 'generated-shim'].includes(shim.origin)
    && executable.origin === 'package' && Object.values(libraries).every(item => item.origin === 'package')
  return { rg, office: { shim, executable, libraries, ...(parseError ? { parseError } : {}) }, verified }
}
