/**
 * Session Integrity - detect ungraceful main-process termination.
 *
 * A native crash (V8 heap OOM, segfault), an external force-kill, or a power loss
 * bypasses `app.before-quit` entirely, so JS-level shutdown logging never runs and
 * the next launch has no record of what happened. This module leaves a marker file
 * on disk for the duration of a session and removes it on graceful shutdown:
 *
 *   - marker present at startup  → previous session ended WITHOUT a clean shutdown
 *   - marker absent  at startup  → previous session exited cleanly
 *
 * It is intentionally foundation-tier: it must run before any heavy init and depends
 * only on Electron's userData path + fs, never on platform/services/apps.
 *
 * Single-marker limitation: the marker is keyed only by userData, so concurrent
 * instances sharing one userData (dev / E2E, where single-instance lock is bypassed)
 * race on the same file and can clear each other's marker. Packaged builds hold the
 * single-instance lock, so only one instance ever arms it.
 */

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

function markerPath(): string {
  return join(app.getPath('userData'), 'session.lock')
}

/**
 * Inspect the previous session's exit, then arm the marker for the current session.
 * Call once at startup, after the app is ready (userData path available).
 */
export function checkAndArmSessionIntegrity(): void {
  const marker = markerPath()
  try {
    if (existsSync(marker)) {
      let prev = ''
      try { prev = readFileSync(marker, 'utf8') } catch { /* unreadable marker is non-fatal */ }
      console.warn(
        `[SessionIntegrity] Previous session did not shut down cleanly ` +
        `(native crash / OOM / force-kill / power loss). Previous: ${prev || 'n/a'}`
      )
    } else {
      console.log('[SessionIntegrity] Previous session exited cleanly')
    }

    writeFileSync(
      marker,
      JSON.stringify({
        pid: process.pid,
        version: app.getVersion(),
        startedAt: new Date().toISOString(),
      })
    )
  } catch (err) {
    console.warn('[SessionIntegrity] Failed to arm session marker:', (err as Error).message)
  }
}

/**
 * Record a clean exit by removing the marker. Call from the graceful shutdown path.
 * Idempotent — safe to call more than once.
 */
export function markSessionCleanExit(): void {
  const marker = markerPath()
  try {
    if (existsSync(marker)) {
      unlinkSync(marker)
      console.log('[SessionIntegrity] Clean exit recorded')
    }
  } catch (err) {
    console.warn('[SessionIntegrity] Failed to clear session marker:', (err as Error).message)
  }
}
