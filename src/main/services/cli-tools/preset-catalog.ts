/**
 * The build's catalog snapshot (`catalog.json`, `halo.cli.catalog/2`) next to
 * the preset bundles. It names each shipped bundle by id, version, revision,
 * sha256 and size, and carries revocation, so an offline first launch checks a
 * bundle exactly as a catalog download would. Nothing here fetches anything or
 * changes live catalog status.
 */

import { open } from 'node:fs/promises'
import { z } from 'zod'
import type { BundleReference } from './bundle'

export const PRESET_CATALOG_FILE = 'catalog.json'
export const PRESET_CATALOG_SCHEMA = 'halo.cli.catalog/2'
const CATALOG_MAX_BYTES = 8 * 1024 * 1024

const builtInTool = z.object({
  id: z.string().max(128).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  revoked: z.boolean(),
  versions: z.array(z.object({
    version: z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
    bundle: z.object({
      revision: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().int().positive(),
    }),
  })),
})
const catalogSchema = z.object({ schema: z.literal(PRESET_CATALOG_SCHEMA), tools: z.array(z.record(z.unknown())) })

export interface PresetCatalog {
  /** The reference of a shipped bundle file, by its `<id>-<version>-r<revision>.zip` name. */
  bundle(fileName: string): BundleReference | undefined
  /** Whether the snapshot revokes the tool, which then is not imported from the build. */
  revoked(id: string): boolean
}

export function presetBundleFileName(ref: Pick<BundleReference, 'id' | 'version' | 'revision'>): string {
  return `${ref.id}-${ref.version}-r${ref.revision}.zip`
}

export async function readPresetCatalog(file: string): Promise<PresetCatalog> {
  const handle = await open(file, 'r')
  let raw: unknown
  try {
    const buffer = Buffer.allocUnsafe(CATALOG_MAX_BYTES + 1)
    const { bytesRead } = await handle.read({ buffer })
    if (bytesRead > CATALOG_MAX_BYTES) throw new Error('Bundled CLI catalog exceeds its size limit')
    raw = JSON.parse(buffer.toString('utf8', 0, bytesRead))
  } finally {
    await handle.close()
  }
  const revoked = new Set<string>()
  const seen = new Set<string>()
  const bundles = new Map<string, BundleReference>()
  for (const item of catalogSchema.parse(raw).tools) {
    if (item.source !== 'builtin') continue
    const parsed = builtInTool.safeParse(item)
    if (!parsed.success) throw new Error('Bundled CLI catalog contains an invalid built-in entry')
    const tool = parsed.data
    if (seen.has(tool.id)) throw new Error('Bundled CLI catalog repeats a built-in tool')
    seen.add(tool.id)
    if (tool.revoked) revoked.add(tool.id)
    for (const entry of tool.versions) {
      const ref = { id: tool.id, version: entry.version, ...entry.bundle }
      const name = presetBundleFileName(ref).toLowerCase()
      if (bundles.has(name)) throw new Error('Bundled CLI catalog repeats a bundle')
      bundles.set(name, ref)
    }
  }
  return {
    bundle: fileName => bundles.get(fileName.toLowerCase()),
    revoked: id => revoked.has(id),
  }
}
