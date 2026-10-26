/**
 * Codex app-server child-process lifecycle.
 *
 * Spawns the `codex app-server` binary as a long-running child process whose
 * stdin/stdout carry newline-delimited JSON-RPC frames (see ../types/jsonrpc.ts
 * for the wire format details). One connection per Halo session.
 *
 * Why a separate file from jsonrpc-client:
 *   - Process management (spawn args, env, cwd, exit handling) is independent
 *     of the JSON-RPC framing/dispatch concerns.
 *   - Lets us test the JSON-RPC client against in-memory streams without a
 *     real binary.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import type { Readable, Writable } from 'stream'
import { getHeadlessElectronPath } from '../../helpers'
import { updateEnvPath } from '../../../child-env'

export interface CodexConnectionOptions {
  /** Absolute path to the `codex` binary. */
  binaryPath: string
  /** True when binaryPath points at @openai/codex's Node.js shim. */
  isJsShim?: boolean
  /** Extra directories prepended to PATH for the child process. */
  pathDirs?: string[]
  /** Environment variables for the child. Halo always sets CODEX_HOME here. */
  env: NodeJS.ProcessEnv
  /** Working directory of the child. */
  cwd: string
  /** Optional handler for stderr (Codex emits debug logs there). */
  onStderr?: (chunk: string) => void
  /** Optional override of CLI args. Default: `['app-server']`. */
  args?: string[]
}

export interface CodexConnection {
  start(): Promise<void>
  stop(): Promise<void>
  isAlive(): boolean
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): () => void
  readonly stdin: Writable
  readonly stdout: Readable
  /** Best-effort PID for diagnostics; null until start() resolves. */
  readonly pid: number | null
}

export interface ResolvedCodexBinary {
  /** Executable or JS shim path passed to the connection. */
  binaryPath: string
  /** Whether binaryPath is the @openai/codex JS shim. */
  isJsShim: boolean
  /** Directories that must be available on PATH for Codex helper tools. */
  pathDirs: string[]
}

/**
 * Resolve the bundled `codex` binary path inside this Electron build. Codex
 * publishes its CLI as `@openai/codex` (which depends on a platform-specific
 * subpackage `@openai/codex-{platform}-{arch}` that contains the actual
 * native binary). In production we resolve the native binary directly instead
 * of executing `bin/codex.js` through Electron-as-Node: the shim is ESM and
 * Electron's Node entrypoint can parse it as CommonJS when launched from the
 * app bundle, causing an immediate SyntaxError before app-server starts.
 *
 * We deliberately reuse `@openai/codex-sdk`'s installation as the carrier
 * for the binary even though we no longer use its TypeScript surface. This
 * matches the user-confirmed packaging strategy (reuse the binary already
 * bundled by @openai/codex-sdk) — zero install changes, zero new
 * supply-chain audit.
 */
export function resolveBundledCodexBinary(): ResolvedCodexBinary | null {
  for (const root of getCodexPackageRoots()) {
    const native = resolveNativeCodexBinary(root)
    if (native) return native
  }

  for (const root of getCodexPackageRoots()) {
    const shim = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (existsSync(shim)) {
      return { binaryPath: shim, isJsShim: true, pathDirs: [] }
    }
  }
  return null
}

function getCodexPackageRoots(): string[] {
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked') : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar') : '',
    process.cwd(),
  ]
  return [...new Set(roots.filter(Boolean))]
}

function resolveNativeCodexBinary(root: string): ResolvedCodexBinary | null {
  const target = getCodexNativeTarget()
  if (!target) return null

  const packageRoot = path.join(root, 'node_modules', '@openai', target.packageName)
  const archRoot = path.join(packageRoot, 'vendor', target.targetTriple)
  const binaryPath = path.join(archRoot, 'codex', target.binaryName)
  if (!existsSync(binaryPath)) return null

  const pathDir = path.join(archRoot, 'path')
  return {
    binaryPath,
    isJsShim: false,
    pathDirs: existsSync(pathDir) ? [pathDir] : [],
  }
}

function getCodexNativeTarget(): { packageName: string; targetTriple: string; binaryName: string } | null {
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') return { packageName: 'codex-darwin-arm64', targetTriple: 'aarch64-apple-darwin', binaryName }
    if (process.arch === 'x64') return { packageName: 'codex-darwin-x64', targetTriple: 'x86_64-apple-darwin', binaryName }
  }
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return { packageName: 'codex-linux-arm64', targetTriple: 'aarch64-unknown-linux-musl', binaryName }
    if (process.arch === 'x64') return { packageName: 'codex-linux-x64', targetTriple: 'x86_64-unknown-linux-musl', binaryName }
  }
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') return { packageName: 'codex-win32-arm64', targetTriple: 'aarch64-pc-windows-msvc', binaryName }
    if (process.arch === 'x64') return { packageName: 'codex-win32-x64', targetTriple: 'x86_64-pc-windows-msvc', binaryName }
  }
  return null
}

/**
 * Default export: a connection backed by a real OS child process.
 */
export function createCodexConnection(options: CodexConnectionOptions): CodexConnection {
  return new ChildProcessConnection(options)
}

class ChildProcessConnection implements CodexConnection {
  private child: ChildProcessWithoutNullStreams | null = null
  private exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>()
  private exited = false
  private stderrBuffer = ''

  constructor(private readonly options: CodexConnectionOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get stdin(): Writable {
    if (!this.child) throw new Error('[Codex] Connection not started')
    return this.child.stdin
  }

  get stdout(): Readable {
    if (!this.child) throw new Error('[Codex] Connection not started')
    return this.child.stdout
  }

  isAlive(): boolean {
    return !this.exited && this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('[Codex] Connection already started')

    const { binaryPath, env, cwd } = this.options
    const args = this.options.args ?? ['app-server']

    const isJsShim = this.options.isJsShim ?? binaryPath.endsWith('.js')

    // For the JS shim path, run the shim through Electron's Helper binary
    // (with ELECTRON_RUN_AS_NODE) instead of process.execPath. The main
    // app binary triggers a macOS Dock icon per child process; the Helper
    // bundle has LSUIElement=true and avoids that. See helpers.ts for the
    // full rationale and fallback behavior.
    const nodePath = isJsShim ? getHeadlessElectronPath() : process.execPath

    const command = isJsShim ? nodePath : binaryPath
    const finalArgs = isJsShim ? [binaryPath, ...args] : args

    const childEnv: NodeJS.ProcessEnv = { ...env }
    const { pathDirs } = this.options
    if (pathDirs?.length) {
      updateEnvPath(childEnv, current => prependPathDirs(pathDirs, current))
    }
    if (isJsShim) {
      // Required so the Electron binary behaves like vanilla Node and runs
      // the shim's main module instead of initializing Chromium.
      childEnv.ELECTRON_RUN_AS_NODE = '1'
    }

    console.log(
      `[Codex][connection] spawning binary=${command} args=${JSON.stringify(finalArgs)} cwd=${cwd} pid_parent=${process.pid}`
    )

    const child = spawn(command, finalArgs, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // We never want the child to inherit stdin TTY behavior.
      windowsHide: true,
    })

    this.child = child

    // Codex emits diagnostics on stderr. Aggregate by line and forward.
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk
      let nl: number
      while ((nl = this.stderrBuffer.indexOf('\n')) >= 0) {
        const line = this.stderrBuffer.slice(0, nl)
        this.stderrBuffer = this.stderrBuffer.slice(nl + 1)
        if (line) this.options.onStderr?.(line)
      }
    })

    child.once('error', (err) => {
      console.error(`[Codex][connection] spawn error:`, err)
      // Wake any in-flight waiters via exit path.
      if (!this.exited) this.handleExit(null, null)
    })

    child.once('exit', (code, signal) => {
      console.log(`[Codex][connection] child exited code=${code} signal=${signal} pid=${child.pid}`)
      // Flush remaining stderr.
      if (this.stderrBuffer) {
        this.options.onStderr?.(this.stderrBuffer)
        this.stderrBuffer = ''
      }
      this.handleExit(code, signal)
    })

    // Wait for spawn — equivalent to once('spawn'), with a small fallback for
    // Node versions that emit it synchronously.
    if (child.pid === undefined) {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.removeListener('error', onError)
          resolve()
        }
        const onError = (err: Error): void => {
          child.removeListener('spawn', onSpawn)
          reject(err)
        }
        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    }

    console.log(`[Codex][connection] spawned pid=${child.pid}`)
  }

  async stop(): Promise<void> {
    if (!this.child || this.exited) return
    const child = this.child
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.exited = true
        resolve()
      }

      // Try graceful shutdown first: end stdin and wait briefly.
      try { child.stdin.end() } catch { /* best-effort */ }

      const killTimer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* already dead */ }
      }, 250)

      const hardKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already dead */ }
      }, 1500)

      child.once('exit', () => {
        clearTimeout(killTimer)
        clearTimeout(hardKillTimer)
        done()
      })

      // If the process already exited before we got here, resolve immediately.
      if (child.exitCode !== null) {
        clearTimeout(killTimer)
        clearTimeout(hardKillTimer)
        done()
      }
    })
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    for (const cb of this.exitListeners) {
      try {
        cb(code, signal)
      } catch (err) {
        console.error(`[Codex][connection] exit listener threw:`, err)
      }
    }
  }
}

function prependPathDirs(dirs: string[], existingPath: string | undefined): string {
  const delimiter = process.platform === 'win32' ? ';' : ':'
  const parts = [...dirs.filter(Boolean), ...(existingPath || '').split(delimiter).filter(Boolean)]
  return [...new Set(parts)].join(delimiter)
}
