/**
 * apps/runtime/im-channels -- Media temp-file store
 *
 * Channel-agnostic staging area for inbound IM media. Adapters download and
 * decrypt platform media, then hand the plaintext here; the runtime only ever
 * sees the returned local path (see InboundAttachment).
 *
 * Files survive one agent execution and are pruned by age at startup, so no
 * adapter has to track individual file lifetimes.
 */

import { readdirSync, statSync, unlinkSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { sanitizeFilename } from '../../../foundation/file-naming'

export interface StagedMediaFile {
  /** Absolute path of the written file. */
  localPath: string
  /** Sanitized display name (the platform-supplied name is untrusted). */
  filename: string
}

/**
 * Write inbound media into `dir` under a collision-proof name.
 * The caller-supplied name is sanitized — it comes off the wire.
 */
export async function stageMediaFile(
  dir: string,
  filename: string,
  data: Buffer,
): Promise<StagedMediaFile> {
  await mkdir(dir, { recursive: true })
  const safeName = sanitizeFilename(filename)
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safeName}`
  const localPath = join(dir, unique)
  await writeFile(localPath, data)
  return { localPath, filename: safeName }
}

/**
 * Remove files in `dir` older than `maxAgeMs`. Returns how many were removed.
 * Missing directories and locked files are not errors.
 */
export function pruneMediaTempDir(dir: string, maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs
  let cleaned = 0
  try {
    for (const name of readdirSync(dir)) {
      const filePath = join(dir, name)
      try {
        if (statSync(filePath).mtimeMs < cutoff) {
          unlinkSync(filePath)
          cleaned++
        }
      } catch {
        /* file may be in use or already gone */
      }
    }
  } catch {
    /* directory may not exist on first run */
  }
  return cleaned
}
