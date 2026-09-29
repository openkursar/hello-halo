/**
 * apps/runtime -- File Export Gate
 *
 * Capability-based security gate for outbound file operations.
 * All files leaving the system boundary (sent to IM channels) must pass through
 * this gate, which validates that the file path is within allowed directories.
 *
 * Design:
 * - `SanctionedFile` is a branded type that can only be constructed by
 *   `FileExportGate.sanction()`. This provides compile-time enforcement:
 *   `ImFileCapability.sendFile()` accepts only `SanctionedFile`, so any new
 *   tool that sends files is forced to go through the gate.
 * - `realpathSync` resolves symlinks to prevent symlink-based path traversal.
 * - Allowed roots are injected at construction time (typically: space path + tmpdir).
 *
 * Threat model:
 *   AI agents running in bypassPermissions mode have full filesystem read access.
 *   This gate prevents the AI from being prompt-injected into *exfiltrating*
 *   sensitive files (e.g., /etc/passwd, ~/.ssh/id_rsa) via IM channels.
 *   It does NOT restrict the AI's ability to read files locally.
 */

import { realpathSync, existsSync } from 'fs'
import { resolve, sep, basename } from 'path'
import type { SanctionedFile } from '../../../shared/types/im-channel'

// Re-export so consumers can import both Gate and type from one place
export type { SanctionedFile } from '../../../shared/types/im-channel'

// ============================================
// Error
// ============================================

export class FileExportDeniedError extends Error {
  readonly code = 'FILE_EXPORT_DENIED'
  readonly requestedPath: string
  readonly allowedRoots: string[]
  readonly reason?: string

  constructor(requestedPath: string, allowedRoots: string[], reason?: string) {
    const roots = allowedRoots.map(r => `"${r}"`).join(', ')
    super(
      reason
        ? `File export denied: "${requestedPath}". ${reason}`
        : `File export denied: "${requestedPath}" is outside allowed directories [${roots}]. ` +
          'Only files within the current space or temporary directory can be sent.'
    )
    this.name = 'FileExportDeniedError'
    this.requestedPath = requestedPath
    this.allowedRoots = allowedRoots
    this.reason = reason
  }
}

// ============================================
// Gate
// ============================================

/**
 * Security gate for outbound file operations.
 *
 * Created per-run (automation) or per-inbound-message (IM chat), scoped to
 * the space's directory and the system temp directory.
 *
 * Usage:
 * ```typescript
 * const gate = new FileExportGate([spacePath, os.tmpdir()])
 * const sanctioned = gate.sanction('/path/to/report.pdf')
 * await channel.sendFile(chatId, sanctioned, chatType)
 * ```
 */
export class FileExportGate {
  private readonly resolvedRoots: string[]

  /**
   * @param allowedRoots - Directories from which files may be exported.
   *   Each root is resolved to an absolute path. Empty or non-existent
   *   roots are silently filtered out.
   * @param refuse - Read at send time: why a file inside the roots may still
   *   not leave (a restricted turn's closed folders), or null.
   */
  constructor(allowedRoots: string[], private readonly refuse?: (realPath: string) => string | null) {
    this.resolvedRoots = allowedRoots
      .filter(r => r.length > 0)
      .map(r => {
        // Resolve to absolute path; use realpath if the directory exists
        // to normalize symlinked roots (e.g., /tmp -> /private/tmp on macOS).
        const abs = resolve(r)
        try {
          return existsSync(abs) ? realpathSync(abs) : abs
        } catch {
          return abs
        }
      })
  }

  /**
   * Validate a file path and produce a SanctionedFile token.
   *
   * @param filePath - The path to validate (may be relative or absolute)
   * @returns A SanctionedFile that can be passed to ImFileCapability.sendFile()
   * @throws FileExportDeniedError if the path is outside allowed roots
   * @throws Error if the file does not exist
   */
  sanction(filePath: string): SanctionedFile {
    // 1. File must exist (can't sanction a non-existent file)
    if (!existsSync(filePath)) {
      throw new Error(`File not found: "${filePath}"`)
    }

    // 2. Resolve symlinks to get the real path
    const realPath = realpathSync(filePath)

    // 3. Check that the real path is within an allowed root
    const isAllowed = this.resolvedRoots.some(root =>
      realPath === root || realPath.startsWith(root + sep)
    )

    if (!isAllowed) {
      throw new FileExportDeniedError(filePath, this.resolvedRoots)
    }
    const refusal = this.refuse?.(realPath)
    if (refusal) {
      throw new FileExportDeniedError(filePath, this.resolvedRoots, refusal)
    }

    // 4. Construct the sanctioned file object.
    //    The brand property is type-level only (unique symbol in the interface).
    //    The cast is safe because only this method can produce SanctionedFile
    //    instances — the branded interface prevents external construction.
    return {
      resolvedPath: realPath,
      displayName: basename(realPath),
    } as SanctionedFile
  }

  /**
   * Human-readable list of allowed root directories (for logging/diagnostics).
   */
  get roots(): readonly string[] {
    return this.resolvedRoots
  }
}
