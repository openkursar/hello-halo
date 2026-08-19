/**
 * package-archive.ts
 *
 * Reading an imported `.zip` / `.dhpkg`.
 *
 * Extraction is synchronous — fflate's `unzipSync` holds the renderer for the
 * whole archive — so the size ceiling belongs at the read itself. Left to each
 * caller it gets forgotten on the path that matters: the skill parser went
 * without one while the cheap type probe had it.
 */

/** Maximum accepted archive size. Beyond this the renderer stalls noticeably. */
export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024

/** Thrown for an archive that is refused before extraction is attempted. */
export class ArchiveTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`Archive is ${(bytes / (1024 * 1024)).toFixed(1)} MB, over the 10 MB limit.`)
  }
}

/**
 * Extract an archive to raw bytes keyed by path.
 *
 * Bytes rather than text: a classifier only needs the keys, and decoding a
 * whole package to read its file names would cost more than the question is
 * worth. Callers that need content decode the entries they actually use.
 */
export async function readArchiveEntries(file: File): Promise<Record<string, Uint8Array>> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new ArchiveTooLarge(file.size)

  const { unzipSync } = await import('fflate')
  return unzipSync(new Uint8Array(await file.arrayBuffer()))
}
