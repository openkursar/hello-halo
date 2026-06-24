/**
 * Headless server-mode boot path.
 *
 * Runs the Electron main process without a window/menu/tray and serves the
 * existing Remote Access HTTP+WebSocket stack, so the same React UI is reachable
 * from a browser. The desktop path is untouched — this only runs when
 * isServerMode() is true (container / serverless deployment).
 *
 * The HTTP server, WebSocket broadcast, and agent event bus are already
 * window-independent (dual-emit: IPC to the window if present, WS broadcast
 * always), so no GUI is required for remote clients to function.
 */
import type { App } from 'electron'
import { initializeEssentialServices, initializeExtendedServices } from './index'
import { enableRemoteAccess } from '../services/remote.service'
import { getServerPort } from '../foundation/runtime-mode'
import { applyEnvConfig } from '../foundation/env-config'

/**
 * Chromium/Electron switches required to start without a display, as root,
 * inside a container. Must be applied before app.whenReady().
 */
export function applyServerModeSwitches(app: App): void {
  app.commandLine.appendSwitch('ozone-platform', 'headless')
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  app.disableHardwareAcceleration()
}

/**
 * Translate container stop signals into a graceful Electron quit.
 *
 * Orchestrators (Knative/K8s) stop a pod with SIGTERM. Electron does not turn
 * that into a 'before-quit', so without this the shutdown sequence (conversation
 * index flush, SQLite checkpoint, app-runtime deactivation) is skipped and the
 * process is hard-killed. app.quit() routes through the existing before-quit
 * handler. A repeated signal falls through to Node's default handler, giving the
 * operator a hard-kill escape hatch if graceful shutdown stalls.
 */
export function installServerSignalHandlers(app: App): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    console.log(`[ServerMode] received ${signal}, quitting gracefully`)
    app.quit()
  }
  process.once('SIGTERM', () => onSignal('SIGTERM'))
  process.once('SIGINT', () => onSignal('SIGINT'))
}

/**
 * Headless init sequence. Mirrors the GUI path's phase ordering but does not
 * wait for a window's ready-to-show event (there is no window), and force-starts
 * remote access regardless of the persisted config flag so the server is always
 * reachable on boot.
 */
export async function bootServerMode(): Promise<void> {
  const port = getServerPort()
  console.log(`[ServerMode] headless boot starting, port=${port}`)

  try {
    // Env-driven config (service token + LLM source) before anything reads it.
    applyEnvConfig()

    initializeEssentialServices()
    console.log('[ServerMode] essential services ready')

    initializeExtendedServices()
    console.log('[ServerMode] extended services dispatched')

    const status = await enableRemoteAccess(port)
    console.log(`[ServerMode] remote access listening on port ${status.server.port}`)
    // Never log the token itself (quick.md rule 11). Operators set it via
    // HALO_REMOTE_PASSWORD, so only its presence is reported here.
    console.log(`[ServerMode] access token: ${status.server.token ? 'configured' : 'NOT SET'}`)
  } catch (err) {
    console.error('[ServerMode] headless boot FAILED:', (err as Error)?.stack || err)
    throw err
  }
}
