import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { CliToolError } from './errors'
import { CLI_MANIFEST_SCHEMA, type CliManifest } from './manifest'
import {
  assertCatalogSignature, guideSignatureAccepted, loadTrustStore, parseCatalogSignature, skillSignatureAccepted,
  TRUSTED_KEYS_FILE,
} from './signature'
import { GUIDE_MAX_BYTES } from './skills'

export const PRESET_CATALOG_FILE = 'catalog.json'
const CATALOG_MAX_BYTES = 8 * 1024 * 1024

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const builtInTool = z.object({
  id: z.string().max(128).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  revoked: z.boolean(),
  skill: z.unknown(),
  versions: z.array(z.object({
    version: z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
    manifestSchema: z.literal(CLI_MANIFEST_SCHEMA),
    archiveSha256: sha256,
    integrity: z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/),
    signature: z.unknown(),
    guide: z.unknown(),
  })),
})
const catalogSchema = z.object({ schema: z.literal('halo.cli.catalog/1'), tools: z.array(z.record(z.unknown())) })
const guideSchema = z.object({ revision: z.number().int().positive(), sha256, content: z.string(), signature: z.unknown() })

type Tool = z.infer<typeof builtInTool>
type Match = { tool: Tool; entry: Tool['versions'][number] }

function acceptedGuide(raw: unknown, label: string, acceptsSignature: (guide: z.infer<typeof guideSchema>) => boolean) {
  if (raw == null) return undefined
  const parsed = guideSchema.safeParse(raw)
  if (!parsed.success || Buffer.byteLength(parsed.data.content, 'utf8') > GUIDE_MAX_BYTES ||
      createHash('sha256').update(parsed.data.content).digest('hex') !== parsed.data.sha256 || !acceptsSignature(parsed.data)) {
    console.warn('[CliTools] Bundled guide ignored: digest, limits or signature not accepted', { tool: label })
    return undefined
  }
  const { revision, sha256, content } = parsed.data
  return { revision, sha256, content }
}

export type PresetCatalog = Awaited<ReturnType<typeof readPresetCatalog>>

/** Read only the package expectations and text needed for offline import; no URLs or catalog status are applied. */
export async function readPresetCatalog(file: string) {
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
  const tools = new Map<string, Tool>()
  const files = new Map<string, Match>()
  for (const item of catalogSchema.parse(raw).tools) {
    if (item.source !== 'builtin') continue
    const parsed = builtInTool.safeParse(item)
    if (!parsed.success) throw new Error('Bundled CLI catalog contains an invalid built-in entry')
    const tool = parsed.data
    if (tools.has(tool.id)) throw new Error('Bundled CLI catalog repeats a built-in tool')
    tools.set(tool.id, tool)
    for (const entry of tool.versions) {
      const name = `${tool.id}-${entry.version}.hcli`.toLowerCase()
      if (files.has(name)) throw new Error('Bundled CLI catalog repeats a package filename')
      files.set(name, { tool, entry })
    }
  }
  const trust = await loadTrustStore(join(dirname(file), TRUSTED_KEYS_FILE))
  return {
    resolve(name: string, manifest: CliManifest, archiveSha256: string) {
      const match = files.get(name.toLowerCase())
      const tool = match?.tool ?? tools.get(manifest.id)
      if (!tool) return undefined
      if (tool.revoked) throw new CliToolError('PACKAGE_INVALID', 'bundled CLI catalog marks this tool as revoked')
      if (tool.versions.length > 0) {
        const entry = match?.entry ?? tool.versions.find(candidate => candidate.version === manifest.version)
        if (!entry || tool.id !== manifest.id || entry.version !== manifest.version) {
          throw new CliToolError('PACKAGE_INVALID', 'bundled CLI does not match the catalog tool and version')
        }
        if (entry.archiveSha256 !== archiveSha256 || entry.integrity !== manifest.integrity) {
          throw new CliToolError('DIGEST_MISMATCH', 'bundled CLI does not match the catalog digests')
        }
        const fields = { id: tool.id, version: entry.version }
        assertCatalogSignature(trust, { ...fields, archiveSha256, integrity: entry.integrity }, parseCatalogSignature(entry.signature))
        const guide = acceptedGuide(entry.guide, `${tool.id}@${entry.version}`, guide =>
          guideSignatureAccepted(trust, { ...fields, ...guide }, parseCatalogSignature(guide.signature)))
        if (guide) return { guide: { ...guide, tool: false } }
      }
      const skill = acceptedGuide(tool.skill, tool.id, guide =>
        skillSignatureAccepted(trust, { id: tool.id, ...guide }, parseCatalogSignature(guide.signature)))
      return { guide: skill && { ...skill, tool: true } }
    },
  }
}
