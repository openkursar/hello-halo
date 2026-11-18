/**
 * Runtime-mode facts derived from the environment.
 *
 * Foundation tier: zero upward deps. Any layer may read these to adapt to a
 * headless/server deployment (container, Knative/serverless) where there is no
 * display, no window, and no desktop session.
 */

import { hostname } from 'os'

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

/**
 * Which deployment this process belongs to — the identity server-mode
 * telemetry is attributed to.
 *
 * The container hostname: on serverless/Knative-style platforms it is the
 * service or function name operators already see in their console, and it
 * survives cold starts, unlike anything written to a container filesystem that
 * may be reset. Scaling out yields one id per replica.
 *
 * Undefined on the desktop: the hostname there is the person's own machine
 * name, which must never be reported.
 */
export function getInstanceId(): string | undefined {
  if (!isServerMode()) return undefined
  return hostname() || undefined
}
