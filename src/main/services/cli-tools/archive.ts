/**
 * Safe extraction of a `.hcli` package (a zip archive) into a staging directory.
 *
 * Zip rather than tar.gz: the app already unpacks `.dhpkg` with fflate, so no
 * new dependency is needed and Windows tooling handles the format natively.
 * Every entry is checked before anything is written: allowed top-level layout,
 * relative `/` paths only, no case-insensitive collisions (they would overwrite
 * each other on macOS and Windows), bounded count and decompressed size.
 * Symlinks cannot be produced: entries are always written as regular files.
 */

import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import { dirname, join } from 'path'
import { unzipSync, type UnzipFileInfo } from 'fflate'
import { CliToolError } from './errors'
import { isSafeRelativePath } from './manifest'

export interface ArchiveLimits {
  /** Compressed archive size. */
  maxArchiveBytes: number
  /** Sum of declared uncompressed entry sizes, checked before inflating. */
  maxExtractedBytes: number
  maxEntries: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: 128 * 1024 * 1024,
  maxExtractedBytes: 512 * 1024 * 1024,
  maxEntries: 50_000,
}

const ALLOWED_ROOTS = new Set(['payload', 'guide', 'LICENSES'])

export interface ExtractedArchive {
  /** sha256 hex of the archive bytes. */
  archiveSha256: string
  fileCount: number
  extractedBytes: number
}

function checkEntryName(name: string): void {
  const path = name.endsWith('/') ? name.slice(0, -1) : name
  if (!isSafeRelativePath(path)) {
    throw new CliToolError('PATH_UNSAFE', `archive entry "${name.slice(0, 200)}" is not a safe relative path`)
  }
  const root = path.split('/')[0]
  if (path !== 'manifest.json' && !ALLOWED_ROOTS.has(root)) {
    throw new CliToolError('PACKAGE_INVALID', `archive entry "${name.slice(0, 200)}" is outside the package layout`)
  }
}

/**
 * Extract `archivePath` into the empty directory `destDir`. Throws a typed
 * error before writing when the archive violates a limit or the layout.
 */
export async function extractPackageArchive(
  archivePath: string,
  destDir: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS
): Promise<ExtractedArchive> {
  let size: number
  try {
    size = (await fsp.stat(archivePath)).size
  } catch {
    throw new CliToolError('PACKAGE_INVALID', 'package archive cannot be read')
  }
  if (size > limits.maxArchiveBytes) {
    throw new CliToolError('PACKAGE_INVALID', `package archive is ${size} bytes (max ${limits.maxArchiveBytes})`)
  }
  const bytes = await fsp.readFile(archivePath)
  const archiveSha256 = createHash('sha256').update(bytes).digest('hex')

  let declared = 0
  let count = 0
  const folded = new Set<string>()
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      filter: (file: UnzipFileInfo) => {
        checkEntryName(file.name)
        const key = (file.name.endsWith('/') ? file.name.slice(0, -1) : file.name).toLowerCase()
        if (folded.has(key)) {
          throw new CliToolError('PATH_UNSAFE', `archive entry "${file.name.slice(0, 200)}" collides with another entry`)
        }
        folded.add(key)
        count += 1
        declared += file.originalSize
        if (count > limits.maxEntries) {
          throw new CliToolError('PACKAGE_INVALID', `package has more than ${limits.maxEntries} entries`)
        }
        if (declared > limits.maxExtractedBytes) {
          throw new CliToolError('PACKAGE_INVALID', `package expands beyond ${limits.maxExtractedBytes} bytes`)
        }
        return true
      },
    })
  } catch (err) {
    if (err instanceof CliToolError) throw err
    throw new CliToolError('PACKAGE_INVALID', 'package archive is not a readable zip file')
  }
  if (!entries['manifest.json']) {
    throw new CliToolError('MANIFEST_INVALID', 'package has no manifest.json at its root')
  }

  let fileCount = 0
  let extractedBytes = 0
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) {
      await fsp.mkdir(join(destDir, name), { recursive: true })
      continue
    }
    extractedBytes += data.byteLength
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new CliToolError('PACKAGE_INVALID', `package expands beyond ${limits.maxExtractedBytes} bytes`)
    }
    const target = join(destDir, name)
    await fsp.mkdir(dirname(target), { recursive: true })
    // 'wx' refuses to follow or replace anything already at the path.
    await fsp.writeFile(target, data, { flag: 'wx', mode: 0o644 })
    fileCount += 1
  }
  return { archiveSha256, fileCount, extractedBytes }
}
