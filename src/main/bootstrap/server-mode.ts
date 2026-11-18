/**
 * Headless server-mode boot path.
 *
 * Runs the Electron main process without a main window/menu/tray and serves the
 * existing Remote Access HTTP+WebSocket stack, so the same React UI is reachable
 * from a browser. The desktop path is untouched — this only runs when
 * isServerMode() is true (container / serverless deployment).
 *
 * The HTTP server, WebSocket broadcast, and agent event bus are already
 * window-independent (dual-emit: IPC to the window if present, WS broadcast
 * always), so no GUI is required for remote clients to function.
 */
import { app, type App } from 'electron'
import { existsSync } from 'fs'
import { initializeEssentialServices, initializeExtendedServices } from './index'
import { enableRemoteAccess } from '../services/remote'
import { getServerPort } from '../foundation/runtime-mode'
import { applyEnvConfig } from '../foundation/env-config'
import { registerBrowserHostHandlers } from '../ipc/browser-host'

/**
 * Chromium/Electron switches for running as root inside a container. Must be
 * applied before app.whenReady().
 *
 * Deliberately does NOT set the Ozone platform. Halo cannot run displayless:
 * under --ozone-platform=headless, constructing any BrowserWindow dereferences a
 * null pointer and the process dies with SIGSEGV (exit 139) — show:true,
 * show:false and paintWhenInitiallyHidden:false all crash identically, because
 * it is window *construction* that fails, not rendering. Measured the same on
 * Electron 29 (Chromium 122) and 43 (Chromium 150). The AI browser needs a host
 * window to attach its <webview> guests to, so a deployment has to supply an
 * in-memory X server (Xvfb) and select x11 on the real command line — the image
 * entrypoint's job, since by the time this runs Ozone has already chosen.
 *
 * Setting it here would not work anyway: Ozone picks its platform before the
 * main script runs, so a late appendSwitch only changes what
 * getSwitchValue() reports, not what is loaded. It used to say 'headless' and
 * survived purely on that accident. Not worth keeping a line that reads as an
 * intent the process cannot satisfy.
 *
 * The same caveat applies to no-sandbox below, and it is not academic: the
 * container runs as root, and Electron's root check also reads the real command
 * line before this file is loaded, aborting with a FATAL at
 * electron_main_delegate.cc (exit 133). So --no-sandbox has to be on argv too —
 * the switch here only reaches process launches that happen later. Both flags
 * are the entrypoint's responsibility; see deploy/server/docker-entrypoint.sh.
 */
export function applyServerModeSwitches(app: App): void {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  app.disableHardwareAcceleration()
}

/**
 * Refuse to boot into a configuration where the AI browser is guaranteed to
 * crash the process.
 *
 * Server mode creates its browser host window lazily, so a bad display setup
 * does not surface at startup — it surfaces as a bare `exit 139`, no log line,
 * from inside the first BrowserWindow constructor, possibly minutes in on the
 * first browser request. That is close to undiagnosable. Both checks below turn
 * it into one actionable message at boot.
 *
 * The ozone check is the load-bearing one. With `--ozone-platform=headless`
 * Chromium initializes perfectly happily and never looks for a display, so
 * nothing complains until a window is constructed and the process dies — and
 * that is precisely the configuration that segfaults. The DISPLAY check only
 * covers the narrower case of headless-without-a-display; for any other ozone
 * platform Chromium's own Ozone init already fails fast and loudly ("Missing X
 * server or $DISPLAY"), before this code is ever reached.
 */
export function assertDisplayAvailable(): void {
  // Reflects the real command line, which is what Ozone actually loaded —
  // unlike an in-process appendSwitch, which cannot change the platform because
  // Ozone selects before the main script runs.
  const platform = app.commandLine.getSwitchValue('ozone-platform')
  if (platform === 'headless') {
    throw new Error(
      'Refusing to boot with --ozone-platform=headless: constructing any ' +
        'BrowserWindow under it dereferences a null pointer and kills the ' +
        'process (SIGSEGV), so the first AI browser call would take the whole ' +
        'server down. Measured on Electron 29 and 43 alike. Run an X server ' +
        '(Xvfb) and pass --ozone-platform=x11 instead; see entrypoint.sh.',
    )
  }

  const display = process.env.DISPLAY
  if (!display) {
    throw new Error(
      'DISPLAY is not set and Halo needs a real window for the AI browser. ' +
        'Start the container through entrypoint.sh, which runs Xvfb and selects ' +
        '--ozone-platform=x11.',
    )
  }
  // ":99" / ":99.0" -> display 99, served by a local unix socket. A remote
  // transport ("host:0") has no local socket, so leave that case to Chromium.
  const local = /^:(\d+)(?:\.\d+)?$/.exec(display)
  if (!local) return
  const socket = `/tmp/.X11-unix/X${local[1]}`
  if (!existsSync(socket)) {
    throw new Error(
      `DISPLAY=${display} but ${socket} does not exist — no X server is listening. ` +
        'Xvfb either failed to start or died; check the entrypoint log.',
    )
  }
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
    // Before anything else: without a usable display, every later AI browser
    // call is an unexplained SIGSEGV. Thrown here, it
    // travels the existing fail-fast path in index.ts (logFatal + exit 1) so the
    // orchestrator restarts instead of serving a half-dead instance.
    assertDisplayAvailable()

    // Env-driven config (service token + LLM source) before anything reads it.
    applyEnvConfig()

    // Lazy hidden browser hosts need their bridge even without a desktop window.
    registerBrowserHostHandlers()

    initializeEssentialServices()
    console.log('[ServerMode] essential services ready')

    await initializeExtendedServices()
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
