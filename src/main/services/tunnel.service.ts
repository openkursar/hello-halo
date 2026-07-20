/**
 * Tunnel Service - Cloudflare Tunnel integration for remote access
 * Directly spawns cloudflared binary to avoid ES Module readonly issues
 *
 * Two modes:
 *   - named: permanent hostname via a named tunnel (credentials granted by
 *     the tunnel issuer, persisted device-side). Survives restarts with the
 *     same URL. Ingress (hostname -> local port) is written locally so the
 *     device stays in control of its own port.
 *   - quick: legacy trycloudflare.com Quick Tunnel with a random per-run
 *     URL. Kept as fallback when no grant can be obtained (issuer down).
 */

import { ChildProcess, spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getHaloDir } from '../foundation/config.service'
import { registerProcess, unregisterProcess, getCurrentInstanceId } from './health'
import type { NamedTunnelGrant } from './tunnel-issuer.client'
import {
  isTunnelSafe,
  TUNNEL_DISABLED_BY_POLICY,
  TUNNEL_DISABLED_BY_POLICY_MESSAGE,
} from './security-policy'

/**
 * Error thrown by tunnel start functions when the tunnel feature is disabled
 * by `security.tunnelSafe`. Carries the stable {@link TUNNEL_DISABLED_BY_POLICY}
 * code so callers / IPC handlers can map it to a localized message
 * without string matching.
 */
export class TunnelDisabledByPolicyError extends Error {
  readonly code = TUNNEL_DISABLED_BY_POLICY
  constructor() {
    super(TUNNEL_DISABLED_BY_POLICY_MESSAGE)
    this.name = 'TunnelDisabledByPolicyError'
  }
}

/**
 * Named-tunnel start failed because the edge rejected the credentials
 * (tunnel deleted/revoked server-side, or secret rotated). The caller can
 * re-request a grant from the issuer and retry — see remote.service.
 */
export class NamedTunnelAuthError extends Error {
  readonly code = 'NAMED_TUNNEL_AUTH'
  constructor(detail: string) {
    super(`Named tunnel credentials rejected: ${detail}`)
    this.name = 'NamedTunnelAuthError'
  }
}

export type TunnelMode = 'named' | 'quick'

// Tunnel state
interface TunnelState {
  process: ChildProcess | null
  url: string | null
  mode: TunnelMode | null
  status: 'stopped' | 'starting' | 'running' | 'error'
  error: string | null
}

const state: TunnelState = {
  process: null,
  url: null,
  mode: null,
  status: 'stopped',
  error: null
}

// Callback for status updates
type StatusCallback = (status: TunnelState) => void
let statusCallback: StatusCallback | null = null

// Set by stopTunnel so exit handlers can tell a user-requested shutdown
// apart from an unexpected process death (which must surface as an error,
// never as a silent transition to 'stopped').
let stopRequested = false

const START_TIMEOUT_MS = 30000
// Named tunnels get a longer budget: the hostname is already known (no URL
// to race for) and cloudflared retries edge dials internally, so on networks
// with slow DNS (10s+ resolver timeouts observed) killing at 30s aborts
// connections that would have succeeded moments later.
const NAMED_START_TIMEOUT_MS = 60000

/**
 * Get the correct binary path (handles asar unpacking)
 */
async function getBinaryPath(): Promise<string> {
  const cloudflared = await import('cloudflared')
  let binPath = cloudflared.bin

  // Fix path for packaged Electron app (asarUnpack)
  if (binPath.includes('app.asar')) {
    binPath = binPath.replace('app.asar', 'app.asar.unpacked')
  }

  return binPath
}

async function ensureBinary(): Promise<string> {
  const cloudflared = await import('cloudflared')
  const binPath = await getBinaryPath()
  if (!existsSync(binPath)) {
    console.log('[Tunnel] Installing cloudflared binary...')
    await cloudflared.install(binPath)
  }
  return binPath
}

/**
 * Write the named-tunnel runtime files (credentials + ingress config) under
 * ~/.halo/tunnel/. Re-written on every start so a changed local port is
 * always reflected. The credentials file is plaintext by cloudflared's
 * requirement; it is scoped to this tunnel only and file-mode 0600.
 */
function writeNamedTunnelFiles(grant: NamedTunnelGrant, localPort: number): string {
  const dir = join(getHaloDir(), 'tunnel')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  const credentialsPath = join(dir, 'credentials.json')
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      AccountTag: grant.accountTag,
      TunnelSecret: grant.tunnelSecret,
      TunnelID: grant.tunnelId,
    }),
    { mode: 0o600 }
  )

  const configPath = join(dir, 'config.yml')
  writeFileSync(
    configPath,
    [
      `tunnel: ${grant.tunnelId}`,
      `credentials-file: ${credentialsPath}`,
      'ingress:',
      `  - hostname: ${grant.hostname}`,
      `    service: http://localhost:${localPort}`,
      '  - service: http_status:404',
      '',
    ].join('\n'),
    { mode: 0o600 }
  )

  return configPath
}

/**
 * Start a named tunnel with the given grant. Resolves with the permanent
 * URL once the connector registers with the edge.
 *
 * Throws {@link NamedTunnelAuthError} when the edge rejects the credentials
 * so the caller can re-issue and retry.
 */
export async function startNamedTunnel(localPort: number, grant: NamedTunnelGrant): Promise<string> {
  if (isTunnelSafe()) {
    console.warn('[Tunnel] startNamedTunnel blocked by security policy (tunnelSafe=true)')
    throw new TunnelDisabledByPolicyError()
  }

  if (state.status === 'running') {
    return state.url!
  }
  if (state.status === 'starting') {
    throw new Error('Tunnel is already starting')
  }

  state.status = 'starting'
  state.mode = 'named'
  state.error = null
  stopRequested = false
  notifyStatus()

  try {
    const binPath = await ensureBinary()
    const configPath = writeNamedTunnelFiles(grant, localPort)
    const url = `https://${grant.hostname}`

    // The permanent hostname is known before the connector registers —
    // surface it immediately so the UI can show the address in 'starting'
    // state instead of a blank wait (edge registration can take a while on
    // slow-DNS networks).
    state.url = url
    notifyStatus()

    console.log('[Tunnel] Starting named tunnel:', grant.hostname, '-> localhost:' + localPort)

    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(
        binPath,
        ['tunnel', '--config', configPath, '--protocol', 'http2', '--no-autoupdate', 'run'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )

      attachProcess(proc)

      let settled = false
      let output = ''

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        console.error('[Tunnel] Timeout waiting for named tunnel registration')
        failState('Timeout waiting for tunnel registration')
        proc.kill()
        reject(new Error('Timeout waiting for tunnel registration'))
      }, NAMED_START_TIMEOUT_MS)

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        output += text
        console.log('[Tunnel] stderr:', text)

        // Connector registered with the edge — the hostname is now live.
        if (!settled && /Registered tunnel connection/i.test(text)) {
          settled = true
          clearTimeout(timeout)
          console.log('[Tunnel] Named tunnel running:', url)
          state.url = url
          state.status = 'running'
          notifyStatus()
          resolve(url)
        }
      })

      proc.stdout?.on('data', (data: Buffer) => {
        console.log('[Tunnel] stdout:', data.toString())
      })

      proc.on('exit', (code) => {
        console.log('[Tunnel] Process exited with code:', code)
        clearProcess()
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          const detail = lastLines(output)
          if (/unauthorized|forbidden|invalid tunnel secret|tunnel not found|credential/i.test(output)) {
            failState('Tunnel credentials rejected')
            reject(new NamedTunnelAuthError(detail))
          } else {
            failState(`cloudflared exited with code ${code}`)
            reject(new Error(`cloudflared exited with code ${code}: ${detail}`))
          }
        } else {
          handleSettledExit(code)
        }
      })

      proc.on('error', (error: Error) => {
        console.error('[Tunnel] Process error:', error)
        clearProcess()
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          failState(error.message)
          reject(error)
        }
      })
    })
  } catch (error) {
    if (state.status === 'starting') {
      failState((error as Error).message)
    }
    throw error
  }
}

/**
 * Start Cloudflare Quick Tunnel (random trycloudflare.com URL, no account).
 * Fallback path when no named-tunnel grant is available.
 *
 * Throws {@link TunnelDisabledByPolicyError} when `security.tunnelSafe`
 * is on. The check happens before any state mutation or cloudflared
 * spawn so a policy-disabled build pays zero runtime cost.
 */
export async function startTunnel(localPort: number): Promise<string> {
  if (isTunnelSafe()) {
    console.warn('[Tunnel] startTunnel blocked by security policy (tunnelSafe=true)')
    throw new TunnelDisabledByPolicyError()
  }

  if (state.status === 'running') {
    return state.url!
  }

  if (state.status === 'starting') {
    throw new Error('Tunnel is already starting')
  }

  state.status = 'starting'
  state.mode = 'quick'
  state.error = null
  stopRequested = false
  notifyStatus()

  return new Promise(async (resolve, reject) => {
    try {
      const binPath = await ensureBinary()

      console.log('[Tunnel] Starting quick tunnel...')
      console.log('[Tunnel] Binary at:', binPath)

      // Spawn cloudflared directly with quick tunnel args
      // Use --protocol http2 to avoid QUIC/UDP being blocked by firewalls/proxies
      const proc = spawn(binPath, ['tunnel', '--url', `http://localhost:${localPort}`, '--protocol', 'http2', '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      attachProcess(proc)

      // Set a timeout for URL to be received
      const timeout = setTimeout(() => {
        console.error('[Tunnel] Timeout waiting for URL')
        failState('Timeout waiting for tunnel URL')
        proc.kill()
        reject(new Error('Timeout waiting for tunnel URL'))
      }, START_TIMEOUT_MS)

      let urlFound = false

      // Parse stderr for the tunnel URL
      proc.stderr?.on('data', (data: Buffer) => {
        const output = data.toString()
        console.log('[Tunnel] stderr:', output)

        // Look for the trycloudflare.com URL
        const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
        if (urlMatch && !urlFound) {
          urlFound = true
          clearTimeout(timeout)
          const url = urlMatch[0]
          console.log('[Tunnel] Got URL:', url)
          state.url = url
          state.status = 'running'
          notifyStatus()
          resolve(url)
        }
      })

      proc.stdout?.on('data', (data: Buffer) => {
        console.log('[Tunnel] stdout:', data.toString())
      })

      // Handle process exit
      proc.on('exit', (code) => {
        console.log('[Tunnel] Process exited with code:', code)
        clearProcess()
        if (!urlFound) {
          clearTimeout(timeout)
          // Keep the timeout error when that is what killed us — it explains
          // more than a bare exit code.
          if (state.status !== 'error') {
            failState(`cloudflared exited with code ${code}`)
          }
          reject(new Error(`cloudflared exited with code ${code}`))
        } else {
          handleSettledExit(code)
        }
      })

      // Handle errors
      proc.on('error', (error: Error) => {
        console.error('[Tunnel] Process error:', error)
        clearTimeout(timeout)
        clearProcess()
        failState(error.message)
        if (!urlFound) {
          reject(error)
        }
      })

    } catch (error: unknown) {
      const err = error as Error
      console.error('[Tunnel] Failed to start:', err)
      failState(err.message)
      reject(err)
    }
  })
}

/**
 * Stop Cloudflare Tunnel
 */
export async function stopTunnel(): Promise<void> {
  if (state.process) {
    console.log('[Tunnel] Stopping tunnel...')
    stopRequested = true

    // Unregister from health system first
    unregisterProcess('tunnel', 'tunnel')

    try {
      state.process.kill('SIGTERM')
    } catch (error) {
      console.error('[Tunnel] Error stopping tunnel:', error)
      // Force kill if SIGTERM fails
      try {
        state.process.kill('SIGKILL')
      } catch {
        // Ignore
      }
    }

    state.process = null
    state.url = null
    state.mode = null
    state.status = 'stopped'
    state.error = null
    notifyStatus()

    console.log('[Tunnel] Tunnel stopped')
  }
}

/**
 * Get tunnel status
 */
export function getTunnelStatus(): TunnelState {
  return { ...state }
}

/**
 * Set status callback
 */
export function onTunnelStatusChange(callback: StatusCallback): void {
  statusCallback = callback
}

/**
 * Notify status change
 */
function notifyStatus(): void {
  if (statusCallback) {
    statusCallback({ ...state })
  }
}

function attachProcess(proc: ChildProcess): void {
  state.process = proc

  // Register with health system for orphan detection
  const instanceId = getCurrentInstanceId()
  if (instanceId && proc.pid) {
    registerProcess({
      id: 'tunnel',
      pid: proc.pid,
      type: 'tunnel',
      instanceId,
      startedAt: Date.now()
    })
  }
}

function clearProcess(): void {
  unregisterProcess('tunnel', 'tunnel')
  state.process = null
}

/**
 * Handle a process exit after the start promise already settled.
 * Three cases, in priority order:
 *   1. user asked for the stop        -> clean 'stopped'
 *   2. we killed it after a failure   -> keep the existing 'error' state
 *      (overwriting it with 'stopped' would erase the only feedback the
 *      user gets about why the tunnel is not running)
 *   3. it died while 'running'        -> unexpected death, surface as error
 */
function handleSettledExit(code: number | null): void {
  state.url = null
  state.mode = null
  if (stopRequested) {
    stopRequested = false
    state.status = 'stopped'
    state.error = null
    notifyStatus()
    return
  }
  if (state.status === 'error') {
    notifyStatus()
    return
  }
  console.error('[Tunnel] Process died unexpectedly, exit code:', code)
  failState(`Tunnel disconnected unexpectedly (exit code ${code})`)
}

function failState(message: string): void {
  state.status = 'error'
  state.error = message
  notifyStatus()
}

function lastLines(output: string, count = 3): string {
  return output.trim().split('\n').slice(-count).join(' | ').slice(0, 500)
}

/**
 * Check if cloudflared is available
 */
export async function checkCloudflaredAvailable(): Promise<boolean> {
  try {
    await import('cloudflared')
    return true
  } catch {
    return false
  }
}
