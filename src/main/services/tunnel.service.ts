/**
 * Tunnel Service - Cloudflare Tunnel integration for remote access
 * Directly spawns cloudflared binary to avoid ES Module readonly issues
 */

import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'

// Tunnel state
interface TunnelState {
  process: ChildProcess | null
  url: string | null
  status: 'stopped' | 'starting' | 'running' | 'error'
  error: string | null
}

const state: TunnelState = {
  process: null,
  url: null,
  status: 'stopped',
  error: null
}

// Callback for status updates
type StatusCallback = (status: TunnelState) => void
let statusCallback: StatusCallback | null = null

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

/**
 * Start Cloudflare Tunnel (Quick Tunnel - no account needed)
 */
export async function startTunnel(localPort: number): Promise<string> {
  if (state.status === 'running') {
    return state.url!
  }

  if (state.status === 'starting') {
    throw new Error('Tunnel is already starting')
  }

  state.status = 'starting'
  state.error = null
  notifyStatus()

  return new Promise(async (resolve, reject) => {
    try {
      const cloudflared = await import('cloudflared')
      const binPath = await getBinaryPath()

      console.log('[Tunnel] Starting cloudflared...')
      console.log('[Tunnel] Binary at:', binPath)

      // Install binary if needed
      if (!existsSync(binPath)) {
        console.log('[Tunnel] Installing binary...')
        await cloudflared.install(binPath)
      }

      // Spawn cloudflared directly with quick tunnel args
      // Use --protocol http2 to avoid QUIC/UDP being blocked by firewalls/proxies
      const proc = spawn(binPath, ['tunnel', '--url', `http://localhost:${localPort}`, '--protocol', 'http2', '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      state.process = proc

      // Set a timeout for URL to be received
      const timeout = setTimeout(() => {
        console.error('[Tunnel] Timeout waiting for URL')
        state.status = 'error'
        state.error = 'Timeout waiting for tunnel URL'
        notifyStatus()
        proc.kill()
        reject(new Error('Timeout waiting for tunnel URL'))
      }, 30000)

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
        if (!urlFound) {
          clearTimeout(timeout)
        }
        state.process = null
        state.url = null
        state.status = 'stopped'
        notifyStatus()
      })

      // Handle errors
      proc.on('error', (error: Error) => {
        console.error('[Tunnel] Process error:', error)
        clearTimeout(timeout)
        state.error = error.message
        state.status = 'error'
        state.process = null
        notifyStatus()
        if (!urlFound) {
          reject(error)
        }
      })

    } catch (error: unknown) {
      const err = error as Error
      console.error('[Tunnel] Failed to start:', err)
      state.status = 'error'
      state.error = err.message
      notifyStatus()
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
