import { zipSync, strToU8 } from 'fflate'
import { stringify as yamlStringify } from 'yaml'
import type { AppSpec } from '../../apps/spec'

/** Maximum total uncompressed size, mirroring the unpack cap. */
const MAX_PACK_BYTES = 50 * 1024 * 1024

/**
 * Pack an AppSpec plus auxiliary files into a `.dhpkg` archive buffer.
 *
 * Layout: `spec.yaml` (the serialized spec) plus each entry from `files`
 * stored under its original relative path. String values are UTF-8 encoded.
 */
export async function pack(
  spec: AppSpec,
  files: Record<string, Buffer | Uint8Array | string> = {},
): Promise<Buffer> {
  const start = Date.now()
  const yaml = yamlStringify(spec)

  const entries: Record<string, Uint8Array> = {
    'spec.yaml': strToU8(yaml),
  }

  let totalBytes = entries['spec.yaml'].byteLength
  for (const [rawPath, value] of Object.entries(files)) {
    const normalized = rawPath.replace(/^\/+/, '').replace(/\\/g, '/')
    // Skip empty paths or anything that would clobber spec.yaml
    if (!normalized || normalized === 'spec.yaml') continue
    const bytes =
      typeof value === 'string'
        ? strToU8(value)
        : value instanceof Buffer
          ? new Uint8Array(value)
          : value
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_PACK_BYTES) {
      throw new Error(
        `[dhpkg/pack] Archive exceeds ${MAX_PACK_BYTES} bytes (current ${totalBytes}). ` +
        `Split very large skills into separate apps or move binary assets out of band.`
      )
    }
    entries[normalized] = bytes
  }

  const archive = zipSync(entries, { level: 6 })
  const buf = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  console.log(
    `[dhpkg/pack] Packed "${spec.name}" v${spec.version ?? '0.0.0'}: ` +
    `${Object.keys(entries).length} entries, ${buf.byteLength} bytes (${Date.now() - start}ms)`
  )
  return buf
}
