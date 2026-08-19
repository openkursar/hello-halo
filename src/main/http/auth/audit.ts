/**
 * Structured audit log for remote-access authentication events.
 *
 * JSON Lines, append-only, rotated when the active file exceeds
 * `MAX_SIZE_BYTES`. Never logs the credential value — only the outcome,
 * source IP, and metadata needed to reconstruct an incident.
 */

import { promises as fs } from 'fs'
import { existsSync, statSync, renameSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'

const MAX_SIZE_BYTES = 5 * 1024 * 1024
const MAX_ROTATED = 3

export type AuthAuditEvent =
  | 'login_success'
  | 'login_fail'
  | 'login_blocked'
  | 'ws_auth_success'
  | 'ws_auth_fail'
  | 'ws_auth_blocked'
  | 'lockout_start'
  | 'password_set'
  | 'password_regenerated'
  | 'credential_restore_failed'

export interface AuthAuditDetail {
  ip?: string
  reason?: string
  ua?: string
  [key: string]: unknown
}

let logPath: string | null = null

function getLogPath(): string {
  if (logPath) return logPath
  logPath = join(app.getPath('userData'), 'logs', 'auth-audit.log')
  const dir = dirname(logPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return logPath
}

function rotateIfNeeded(path: string): void {
  if (!existsSync(path)) return
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size < MAX_SIZE_BYTES) return

  // Shift .N → .N+1 from the top down.
  for (let i = MAX_ROTATED - 1; i >= 1; i--) {
    const from = `${path}.${i}`
    const to = `${path}.${i + 1}`
    if (existsSync(from)) {
      try {
        renameSync(from, to)
      } catch {
        // Best-effort rotation; never block the auth path.
      }
    }
  }
  try {
    renameSync(path, `${path}.1`)
  } catch {
    // Ignored; next write will just keep appending.
  }
}

/**
 * Append one event. Errors are swallowed because audit logging must
 * never break the login path. Failures are surfaced to the dev console.
 */
export function logAuthEvent(event: AuthAuditEvent, detail: AuthAuditDetail = {}): void {
  const path = getLogPath()
  rotateIfNeeded(path)

  const entry = {
    ts: new Date().toISOString(),
    event,
    ...detail,
  }
  const line = JSON.stringify(entry) + '\n'

  // Fire-and-forget. Sequential ordering across concurrent writes is
  // acceptable because we use the O_APPEND semantics of fs.appendFile.
  fs.appendFile(path, line).catch((err) => {
    console.warn('[Auth] Failed to write audit log:', (err as Error).message)
  })
}
