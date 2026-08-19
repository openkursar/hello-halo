/**
 * Runtime-mode facts derived from the environment.
 *
 * Foundation tier: zero upward deps. Any layer may read these to adapt to a
 * headless/server deployment (container, Knative/serverless) where there is no
 * display, no window, and no desktop session.
 */

/**
 * Headless server mode: the main process runs without a window/menu/tray and
 * serves the Remote Access HTTP+WebSocket stack instead. Gated on HALO_SERVER_MODE
 * so the desktop path is unaffected when the flag is absent.
 */
export function isServerMode(): boolean {
  const v = process.env.HALO_SERVER_MODE
  return v === '1' || v === 'true'
}

/**
 * Port the headless HTTP server should bind. Honors the platform-provided PORT
 * (Knative/WFaaS inject it) first, then HALO_SERVER_PORT, falling back to 8080.
 */
export function getServerPort(): number {
  const raw = process.env.PORT || process.env.HALO_SERVER_PORT
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 8080
}
