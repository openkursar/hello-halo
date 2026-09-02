/**
 * Analytics IPC Handler
 *
 * Provides a fire-and-forget channel (`analytics:report`) for the renderer
 * process to send telemetry events to the main process analytics pipeline.
 *
 * Protocol:
 *   Renderer → Main via ipcRenderer.send (no response expected).
 *   Main validates the payload shape, then forwards to analytics.track().
 *
 * Security notes:
 *   - Only whitelisted event names are accepted — `RENDERER_ALLOWED_EVENTS`
 *     in `services/analytics/types.ts`, shared with the `/api/analytics/report`
 *     HTTP route so desktop and remote/Capacitor clients are held to the
 *     same boundary.
 *   - Properties are shallow-validated (must be plain object or undefined).
 *   - The TelemetryProvider applies its own per-event whitelist and global
 *     blocklist on top, so even if the renderer sends unexpected keys they
 *     will be stripped before transmission.
 */

import { ipcMain } from 'electron'
import { analytics } from '../services/analytics/analytics.service'
import { RENDERER_ALLOWED_EVENTS } from '../services/analytics/types'

/**
 * Register the analytics IPC listener.
 *
 * Uses `ipcMain.on` (not `.handle`) because this is fire-and-forget —
 * the renderer does not await a response, and failures are silently logged.
 */
export function registerAnalyticsHandlers(): void {
  ipcMain.on('analytics:report', (_event, payload: unknown) => {
    try {
      if (!isValidPayload(payload)) {
        return
      }

      const { event, properties } = payload

      if (!RENDERER_ALLOWED_EVENTS.has(event)) {
        console.warn(`[Analytics/IPC] Rejected unknown event: ${event}`)
        return
      }

      void analytics.track(event, properties ?? {})
    } catch (err) {
      // Never throw from a fire-and-forget handler
      console.warn('[Analytics/IPC] Error processing report:', err)
    }
  })
}

/** Type guard: minimal shape validation for the IPC payload. */
function isValidPayload(
  payload: unknown
): payload is { event: string; properties?: Record<string, unknown> } {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  if (typeof p.event !== 'string' || p.event.length === 0) return false
  if (p.properties !== undefined && (typeof p.properties !== 'object' || p.properties === null)) {
    return false
  }
  return true
}
