/**
 * Session Integrity - detect ungraceful main-process termination.
 *
 * A native crash (V8 heap OOM, segfault), an external force-kill, or a power loss
 * bypasses `app.before-quit` entirely, so JS-level shutdown logging never runs and
 * the next launch has no record of what happened. This module leaves a marker file
 * on disk for the duration of a session and removes it on graceful shutdown:
 *
 *   - marker absent  at startup            → previous session exited cleanly
 *   - marker present with an exit reason   → previous session was relaunched on purpose
 *   - marker present without a reason      → previous session ended WITHOUT a clean shutdown
 *
 * A relaunch records its reason instead of removing the marker: a relaunch forced by
 * repeated failures is evidence, and clearing the marker would hide it.
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

export type PreviousSessionExit =
  | { kind: 'clean' }
  | { kind: 'relaunch'; reason: string; previousVersion?: string }
  | { kind: 'unclean'; previousVersion?: string }

interface SessionMarker {
  pid?: number
  version?: string
  startedAt?: string
  exit?: { reason: string; at: string }
}

let previousExit: PreviousSessionExit = { kind: 'clean' }

function markerPath(): string {
  return join(app.getPath('userData'), 'session.lock')
}

function parseMarker(raw: string): SessionMarker | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as SessionMarker) : null
  } catch {
    return null
  }
}

/**
 * Inspect the previous session's exit, then arm the marker for the current session.
 * Call once at startup, after the app is ready (userData path available).
 */
export function checkAndArmSessionIntegrity(): PreviousSessionExit {
  const marker = markerPath()
  try {
    if (existsSync(marker)) {
      let prev = ''
      try { prev = readFileSync(marker, 'utf8') } catch { /* unreadable marker is non-fatal */ }
      const parsed = parseMarker(prev)
      if (parsed?.exit?.reason) {
        previousExit = { kind: 'relaunch', reason: parsed.exit.reason, previousVersion: parsed.version }
        console.warn(
          `[SessionIntegrity] Previous session relaunched: reason=${parsed.exit.reason} at=${parsed.exit.at}`
        )
      } else {
        previousExit = { kind: 'unclean', previousVersion: parsed?.version }
        console.warn(
          `[SessionIntegrity] Previous session did not shut down cleanly ` +
          `(native crash / OOM / force-kill / power loss). Previous: ${prev || 'n/a'}`
        )
      }
    } else {
      previousExit = { kind: 'clean' }
      console.log('[SessionIntegrity] Previous session exited cleanly')
    }

    const armed: SessionMarker = {
      pid: process.pid,
      version: app.getVersion(),
      startedAt: new Date().toISOString(),
    }
    writeFileSync(marker, JSON.stringify(armed))
  } catch (err) {
    console.warn('[SessionIntegrity] Failed to arm session marker:', (err as Error).message)
  }
  return previousExit
}

/** How the previous session ended, as found by `checkAndArmSessionIntegrity`. */
export function getPreviousSessionExit(): PreviousSessionExit {
  return previousExit
}

/**
 * Record why this session is about to exit without a graceful shutdown (a relaunch).
 * The marker stays on disk, so the next launch attributes the exit to `reason`
 * instead of reading it as either clean or an unexplained crash. Synchronous: the
 * caller exits the process on the next statement.
 */
export function recordSessionExitReason(reason: string): void {
  const marker = markerPath()
  try {
    let current: SessionMarker = {}
    if (existsSync(marker)) {
      try { current = parseMarker(readFileSync(marker, 'utf8')) ?? {} } catch { /* rewrite below */ }
    }
    const next: SessionMarker = { ...current, exit: { reason, at: new Date().toISOString() } }
    writeFileSync(marker, JSON.stringify(next))
  } catch (err) {
    console.warn('[SessionIntegrity] Failed to record exit reason:', (err as Error).message)
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
