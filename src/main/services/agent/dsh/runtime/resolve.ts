/**
 * Locate a runnable dsh runtime inside this Electron build.
 *
 * dsh is JavaScript rather than a native binary, so unlike
 * `codex/transport/connection.ts` (which resolves a platform executable) we
 * resolve a JS entry and run it through Electron-as-Node.
 *
 * The entry is the single-file bundle built by `runtimes/dsh/build.mjs`,
 * not a `node_modules` tree. The engine's ~400 npm packages are compiled into
 * it and its cordis plugins are registered as loader builtins, so nothing here
 * resolves a package at runtime — see `runtimes/dsh/manifest.cjs` for
 * why, and `./cordis-config.ts` for how the composition names them.
 *
 * `@deepseek-ai/dsh` (the `dsh` CLI) is deliberately NOT used: it is a profile
 * launcher over `$DSH_HOME/profiles` and does not accept a cordis config.
 *
 * Three things must be resolved, not one: the JS entry, an interpreter new
 * enough to load it, and the bash its shell tools run commands through.
 * Electron-as-Node is preferred as the interpreter (it always exists), but its
 * bundled Node lags the standalone release, so a system `node` is the
 * fallback — see `resolveDshInterpreter`.
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { detectGitBash } from '../../../git-bash'
import { getHeadlessElectronPath } from '../../helpers'

/**
 * Lowest Node the runtime boots on: the floor the harness itself declares
 * (`engines.node` of the deepseek-harness workspace, `^22.19.0 || >=24`).
 *
 * The floor is checked rather than discovered at runtime because the loader
 * settles plugin entries independently: a Node that cannot import one plugin
 * still completes the handshake and serves a quietly smaller tool set instead
 * of failing. Node 20.16 advertised 12 of the 17 tools that way, losing
 * read/write/edit/todo_write/subagent with no error the user could see.
 */
const MIN_NODE_VERSION: readonly [number, number] = [22, 19]

export interface ResolvedDshInterpreter {
  command: string
  /** Env additions the interpreter needs. Electron must be told to be Node. */
  env: Record<string, string>
  /** For logs: which candidate won and at what version. */
  description: string
}

export interface ResolvedDshRuntime {
  /** Absolute path to the JS bundle that boots a cordis config. */
  entryPath: string
  /** dsh version the bundle was built from; empty when the manifest is unreadable. */
  version: string
}

export interface ResolvedDshShell {
  /** Absolute path to the bash the runtime's shell tools should run. */
  path: string
  /** Directory to prepend to the child PATH, or null when bash is already on it. */
  pathPrepend: string | null
}

/**
 * Bundle location relative to an app root. Mirrors `RUNTIME_DIR` /
 * `RUNTIME_ENTRY` in `runtimes/dsh/manifest.cjs`, which the build side
 * reads; a build script cannot be imported from the packaged main process, so
 * the two are held together by
 * `tests/unit/services/agent/dsh/runtime-manifest.test.ts`.
 */
const RUNTIME_DIR_SEGMENTS = ['resources', 'dsh-runtime']
const RUNTIME_ENTRY_SEGMENTS = [...RUNTIME_DIR_SEGMENTS, 'lib', 'runtime.mjs']

export function resolveDshRuntime(): ResolvedDshRuntime | null {
  for (const root of getDshRuntimeRoots()) {
    const entryPath = path.join(root, ...RUNTIME_ENTRY_SEGMENTS)
    if (!existsSync(entryPath)) continue
    return { entryPath, version: readBundleVersion(path.join(root, ...RUNTIME_DIR_SEGMENTS)) }
  }
  return null
}

function readBundleVersion(runtimeDir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(runtimeDir, 'package.json'), 'utf-8'))
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
}

/**
 * Pick the interpreter that runs the runtime entry.
 *
 * Electron's bundled Node is the default because it always ships with the app,
 * but it trails the standalone release by months and the runtime uses APIs from
 * the newer line. When it is too old the only alternative is a `node` on PATH,
 * which is an external dependency Halo otherwise does not have — so this
 * returns null rather than guessing, and the caller reports what is missing.
 *
 * `HALO_DSH_NODE` overrides everything, unvalidated, for testing against a
 * specific build.
 */
export function resolveDshInterpreter(): ResolvedDshInterpreter | null {
  const override = process.env.HALO_DSH_NODE
  if (override) {
    return { command: override, env: {}, description: `HALO_DSH_NODE=${override}` }
  }

  if (satisfiesMinNode(process.versions.node)) {
    return {
      command: getHeadlessElectronPath(),
      env: { ELECTRON_RUN_AS_NODE: '1' },
      description: `Electron-as-Node ${process.versions.node}`,
    }
  }

  const systemVersion = probeSystemNodeVersion()
  if (systemVersion && satisfiesMinNode(systemVersion)) {
    return { command: 'node', env: {}, description: `system node ${systemVersion}` }
  }

  console.warn(
    `[Dsh][runtime] no interpreter meets Node >= ${MIN_NODE_VERSION.join('.')} ` +
      `(Electron bundles ${process.versions.node}, system node ${systemVersion ?? 'not found'})`
  )
  return null
}

/**
 * Locate the bash the runtime's shell tools run commands through.
 *
 * Both shell surfaces need it and neither can find it alone on Windows:
 * `dsh-bash-local` spawns the fixed argv `bash -c <command>` with no path
 * hook, so bash must answer to that bare name on the child's PATH, and
 * `dsh-terminal-bash` defaults to a POSIX path that does not exist there.
 * Halo's Git Bash — already a requirement of the Claude engine — supplies both
 * answers, so the two engines execute commands in the same environment.
 *
 * Returns null only on a Windows install with no Git Bash. The shell tools
 * then degrade (see `cordis-config.ts`) while the rest of the tool set keeps
 * working, which beats refusing to launch over one capability.
 */
export function resolveDshShell(): ResolvedDshShell | null {
  const detection = detectGitBash()
  if (!detection.found || !detection.path) return null

  // POSIX bash is already on PATH; reordering it there would shadow whatever
  // the user put ahead of the system directories.
  const pathPrepend = process.platform === 'win32' ? path.dirname(detection.path) : null
  return { path: detection.path, pathPrepend }
}

export function describeMinNodeVersion(): string {
  return MIN_NODE_VERSION.join('.')
}

function satisfiesMinNode(version: string | undefined): boolean {
  if (!version) return false
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  if (major !== MIN_NODE_VERSION[0]) return major > MIN_NODE_VERSION[0]
  return minor >= MIN_NODE_VERSION[1]
}

function probeSystemNodeVersion(): string | null {
  try {
    return execFileSync('node', ['--version'], { encoding: 'utf-8', timeout: 3000 }).trim()
  } catch {
    return null
  }
}

/**
 * Candidate app roots, most specific first. A packaged build keeps the bundle
 * under `app.asar.unpacked` because a child Node process cannot read inside an
 * asar archive; dev runs from the project root.
 */
function getDshRuntimeRoots(): string[] {
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked') : '',
    process.cwd(),
  ]
  return [...new Set(roots.filter(Boolean))]
}
