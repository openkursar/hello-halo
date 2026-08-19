/**
 * Unit tests for the archive read ceiling.
 *
 * Extraction is synchronous, so an oversized archive freezes the renderer.
 * The ceiling lives at the read because leaving it to each caller is exactly
 * how the skill parser ended up without one.
 */

import { describe, it, expect } from 'vitest'
import {
  readArchiveEntries,
  ArchiveTooLarge,
  MAX_ARCHIVE_BYTES,
} from '../../../src/renderer/components/apps/package-archive'

/** A File stand-in: the size gate is reached before any byte is read. */
function fileOfSize(bytes: number): File {
  return { name: 'pkg.zip', size: bytes } as File
}

describe('readArchiveEntries', () => {
  it('refuses an oversized archive before extracting it', async () => {
    await expect(readArchiveEntries(fileOfSize(MAX_ARCHIVE_BYTES + 1)))
      .rejects.toBeInstanceOf(ArchiveTooLarge)
  })

  it('reports the offending size, so the refusal is actionable', async () => {
    await expect(readArchiveEntries(fileOfSize(15 * 1024 * 1024)))
      .rejects.toThrow(/15\.0 MB/)
  })

  it('admits an archive at the limit', async () => {
    // Reaches extraction and fails there instead — the gate let it through.
    await expect(readArchiveEntries(fileOfSize(MAX_ARCHIVE_BYTES)))
      .rejects.not.toBeInstanceOf(ArchiveTooLarge)
  })
})
