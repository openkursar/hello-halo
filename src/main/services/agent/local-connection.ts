/**
 * Local connections refused by security software.
 *
 * Engines reach every model through Halo's router on 127.0.0.1. Security
 * software that filters connections per program can refuse that connection for
 * the engine's process while the app itself gets through, and the engine then
 * reports only an EACCES/EPERM that reads like a model or gateway failure. This
 * module says what such a report means and which program to allow, and makes
 * the same connection from a child process for the diagnostics.
 */

import { spawn } from 'node:child_process'
import type { ChildLocalConnectionInfo } from '../../../shared/types/health'
import { getActiveEngine } from './resolved-sdk'
import { getHeadlessElectronPath } from './helpers'
import { resolveBundledCodexBinary } from './codex/transport/connection'

/**
 * A connect() to the router refused by the system, as engines report it:
 * Claude Code CLI 2.1.89 says "Unable to connect to API (EACCES)"; Node's own
 * wording, which Node-based engines pass on, is "connect EACCES 127.0.0.1:<port>";
 * the halo engine says "fetch failed (EACCES)" — it words only a failed model
 * call that way, and Halo points every model call of it at the router.
 */
const REFUSED_LOCAL_CONNECTION = [
  /Unable to connect to API \((?:EACCES|EPERM)\)/,
  /connect (?:EACCES|EPERM) (?:127\.0\.0\.1|::1|localhost)\b/,
  /\bfetch failed \((?:EACCES|EPERM)\)/,
]

const BLOCKED_CODES = new Set(['EACCES', 'EPERM'])

const CHECK_TIMEOUT_MS = 5000

/** The program whose connection the router sees: what an allowlist has to name. */
export function localConnectionProgram(): string {
  switch (getActiveEngine()) {
    case 'halo':
      return process.execPath
    case 'codex': {
      const codex = resolveBundledCodexBinary()
      return codex && !codex.isJsShim ? codex.binaryPath : getHeadlessElectronPath()
    }
    default:
      return getHeadlessElectronPath()
  }
}

/**
 * Whether an error is a refused local connection: an engine's own report, or
 * the explanation `explainEngineError` made of one (it quotes the report).
 */
export function isRefusedLocalConnection(error: string): boolean {
  return REFUSED_LOCAL_CONNECTION.some(pattern => pattern.test(error))
}

/**
 * An engine error as the user should read it: a refused local connection is
 * explained, with the program to allow; any other error comes back unchanged.
 */
export function explainEngineError(error: string): string {
  if (!isRefusedLocalConnection(error)) return error
  return (
    "Security software on this computer blocked Halo's internal connection to 127.0.0.1, so the request never " +
    'reached the model. This is not a problem with the model, the account or the gateway. Ask your IT team to ' +
    `allow this program to make local connections: ${localConnectionProgram()} (engine error: ${error})`
  )
}

/**
 * Connect to the router from a child process started the way engine processes
 * start (the same program, run as Node), which is what security software
 * filters: the app's own connection can succeed while this one is refused.
 */
export function checkChildLocalConnection(port: number): Promise<ChildLocalConnectionInfo> {
  const program = getHeadlessElectronPath()
  const script =
    `const socket = require('net').connect(${Math.trunc(port)}, '127.0.0.1');` +
    `const done = (out, code) => { process.stdout.write(out); process.exit(code) };` +
    `socket.once('connect', () => { socket.destroy(); done('connected', 0) });` +
    `socket.once('error', (err) => done(String(err.code || err.message), 1));` +
    `setTimeout(() => done('ETIMEDOUT', 1), ${CHECK_TIMEOUT_MS}).unref();`

  return new Promise(resolve => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(error === undefined
        ? { reachable: true, blocked: false, program }
        : { reachable: false, blocked: BLOCKED_CODES.has(error), error, program })
    }

    const child = spawn(program, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // The child gives up on its own; this covers one that never gets that far.
    const timer = setTimeout(() => {
      child.kill()
      finish('ETIMEDOUT')
    }, CHECK_TIMEOUT_MS * 2)

    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', err => finish((err as NodeJS.ErrnoException).code || err.message))
    child.on('close', code => {
      const out = stdout.trim()
      if (code === 0 && out === 'connected') finish()
      else finish(out || stderr.trim().slice(0, 200) || `exit code ${code}`)
    })
  })
}
