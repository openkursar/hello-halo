/**
 * Locate a runnable dsh runtime inside this Electron build.
 *
 * dsh ships as plain ESM npm packages rather than a native binary, so unlike
 * `codex/transport/connection.ts` (which resolves a platform executable) we
 * resolve a JS entry and run it through Electron-as-Node.
 *
 * The entry is `@deepseek-ai/dsh-sdk-jsonrpc-demo`'s **packaged** bin, not its
 * generic one. Both boot an external cordis config, but the packaged bin passes
 * its own module URL as the Loader's bare-module base, so plugin names in the
 * config resolve against the installed package tree instead of the config's own
 * directory. That is what lets Halo keep the config outside `node_modules`
 * (see `./cordis-config.ts`).
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
import { existsSync } from 'fs'
import path from 'path'
import { detectGitBash } from '../../../git-bash'
import { getHeadlessElectronPath } from '../../helpers'

/**
 * Lowest Node the runtime boots on.
 *
 * The binding constraint is `@deepseek-ai/dsh-session-persistence-jsonl`, which
 * imports the zstd family from `node:zlib` — added in 22.15. It is not the only
 * version-sensitive package (`dsh-app-boot` needs `parseEnv`, added in 20.12)
 * but it is the highest floor, so it sets this number.
 *
 * The floor is checked rather than discovered at runtime because the loader
 * settles plugin entries independently: a Node that cannot import one plugin
 * still completes the handshake and serves a quietly smaller tool set instead
 * of failing. Node 20.16 advertised 12 of the 17 tools that way, losing
 * read/write/edit/todo_write/subagent with no error the user could see.
 */
const MIN_NODE_VERSION: readonly [number, number] = [22, 15]

export interface ResolvedDshInterpreter {
  command: string
  /** Env additions the interpreter needs. Electron must be told to be Node. */
  env: Record<string, string>
  /** For logs: which candidate won and at what version. */
  description: string
}

export interface ResolvedDshRuntime {
  /** Absolute path to the JS bin that boots a cordis config. */
  entryPath: string
  /** Package root the entry was found under; also the plugin resolution root. */
  packageRoot: string
}

export interface ResolvedDshShell {
  /** Absolute path to the bash the runtime's shell tools should run. */
  path: string
  /** Directory to prepend to the child PATH, or null when bash is already on it. */
  pathPrepend: string | null
}

const RUNTIME_ENTRY_SEGMENTS = [
  'node_modules',
  '@deepseek-ai',
  'dsh-sdk-jsonrpc-demo',
  'lib',
  'packaged-bin.js',
]

/**
 * The plugin the config's JSON-RPC surface comes from. Its presence is what
 * makes a package root usable — the entry alone cannot serve the protocol.
 */
const REQUIRED_PLUGIN_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-server']

export function resolveDshRuntime(): ResolvedDshRuntime | null {
  for (const root of getDshPackageRoots()) {
    const entryPath = path.join(root, ...RUNTIME_ENTRY_SEGMENTS)
    if (!existsSync(entryPath)) continue
    if (!existsSync(path.join(root, ...REQUIRED_PLUGIN_SEGMENTS))) {
      console.warn(
        `[Dsh][runtime] found runtime entry at ${entryPath} but @deepseek-ai/dsh-sdk-jsonrpc-server is missing under ${root}; skipping root`
      )
      continue
    }
    return { entryPath, packageRoot: root }
  }
  return null
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
 * Candidate roots, most specific first. Mirrors `getCodexPackageRoots`:
 * packaged builds keep dependencies under `app.asar.unpacked` (a child Node
 * process cannot import from inside an asar archive), dev runs from cwd.
 */
function getDshPackageRoots(): string[] {
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked') : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar') : '',
    process.cwd(),
  ]
  return [...new Set(roots.filter(Boolean))]
}
