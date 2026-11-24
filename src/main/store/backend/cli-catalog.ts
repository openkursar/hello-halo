/**
 * CLI tool catalog — the administrator-reviewed command-line tools the primary
 * source offers this account, merged with what is installed on this device.
 *
 * Primary source only, like "my publications": the catalog and its packages
 * are read with the build's account token, and that token belongs to one
 * store. Nothing is downloaded until the user installs a version; listing the
 * catalog never fetches a package.
 *
 * Every successful catalog read applies the catalog's status to installed
 * tools (`applyCatalogStatus`): revocation, delisting of catalog tools it no
 * longer lists, withdrawn versions and available updates. A revoked or
 * delisted tool leaves new executions as soon as this device learns of it;
 * an update is only flagged, never downloaded. An administrator's guide
 * override of a version replaces the package guide for new executions once
 * its digest (and, when the build ships trusted keys, its signature) checks
 * out; a malformed one is ignored. The tool's skill, carried on the tool
 * entry, reaches installed preset copies the same way. Installing re-reads the catalog first and
 * refuses a revoked tool or a version the catalog no longer lists, checks the
 * version's signature when the build ships trusted keys, then checks
 * the archive sha256 here and hands the file to cli-tools, which checks the
 * payload integrity, id and version before publishing it.
 *
 * See DESIGN.md §3.13.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPrimaryRegistry } from '../registry.service'
import { getAdapter } from '../adapters'
import { getStoreIdentityToken } from './identity'
import {
  DEFAULT_ARCHIVE_LIMITS,
  GUIDE_MAX_BYTES,
  applyCatalogStatus,
  installCatalogPackage,
  parseCatalogSignature,
  readCliToolState,
  verifyCatalogSignature,
} from '../../services/cli-tools'
import type { CatalogGuideOverride, CatalogSignature, CatalogToolStatus, CliToolState } from '../../services/cli-tools'
import { STORE_NOT_SIGNED_IN } from '../../../shared/store/store-types'
import type {
  CliCatalog,
  CliCatalogTool,
  CliCatalogVersion,
  RegistrySource,
} from '../../../shared/store/store-types'
import type { RegistryAdapter, RegistryAuth } from '../adapters/types'

export const CLI_CATALOG_SCHEMA = 'halo.cli.catalog/1'

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const INTEGRITY = /^sha256-[A-Za-z0-9+/]{43}=$/

/** A catalog version with the fields only the main process may see. */
interface CatalogVersionRecord {
  view: CliCatalogVersion
  archiveSha256: string
  integrity: string
  downloadUrl: string
  /** Null when the catalog carries none (or one of an unknown shape). */
  signature: CatalogSignature | null
  /**
   * The administrator's guide: null when there is none (the package guide
   * applies), `'invalid'` when one was sent but failed validation — then this
   * device leaves the version's guide as it is.
   */
  guide: CatalogGuideOverride | null | 'invalid'
}

interface CatalogToolRecord {
  id: string
  displayName: string
  source: string
  revoked: boolean
  /** Empty when the tool has no approved version (a status-only entry). */
  latest: string
  versions: CatalogVersionRecord[]
  /** The tool's skill, for copies not installed from the catalog. */
  skill: CatalogGuideOverride | null | 'invalid'
}

/**
 * The primary source's implementation of `method`, bound. Null when there is
 * no enabled primary source or its driver has no such endpoint. Whether the
 * method exists follows the driver, never the handshake (DESIGN.md §3.1): a
 * DHP v2 source without a catalog answers 404, which reads as "none".
 */
function primaryEndpoint<M extends 'fetchCliCatalog' | 'downloadCliPackage'>(
  method: M,
): { source: RegistrySource; call: NonNullable<RegistryAdapter[M]> } | null {
  const source = getPrimaryRegistry()
  if (!source) return null
  const adapter = getAdapter(source)
  const call = adapter[method]
  return call ? { source, call: call.bind(adapter) as NonNullable<RegistryAdapter[M]> } : null
}

async function requireAuth(): Promise<RegistryAuth> {
  const token = await getStoreIdentityToken()
  if (!token) throw new Error(STORE_NOT_SIGNED_IN)
  return { token }
}

function currentPlatform(): string {
  return `${process.platform}-${process.arch}`
}

function readString(value: unknown, max = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function parseGuide(raw: unknown): CatalogGuideOverride | null | 'invalid' {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') return 'invalid'
  const g = raw as Record<string, unknown>
  const revision = g.revision
  const sha256 = g.sha256
  const content = g.content
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return 'invalid'
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return 'invalid'
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf-8') > GUIDE_MAX_BYTES) return 'invalid'
  if (createHash('sha256').update(content, 'utf-8').digest('hex') !== sha256) return 'invalid'
  return { revision, sha256, content, signature: parseCatalogSignature(g.signature) }
}

function parseVersion(raw: unknown): CatalogVersionRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const version = readString(v.version, 64)
  const archiveSha256 = readString(v.archiveSha256, 64)
  const integrity = readString(v.integrity, 64)
  const downloadUrl = readString(v.downloadUrl, 512)
  if (!version || !VERSION_PATTERN.test(version)) return null
  if (!archiveSha256 || !SHA256_HEX.test(archiveSha256)) return null
  if (!integrity || !INTEGRITY.test(integrity)) return null
  if (!downloadUrl) return null
  const size = typeof v.size === 'number' && Number.isFinite(v.size) && v.size >= 0 ? v.size : 0
  const platforms = Array.isArray(v.platforms)
    ? v.platforms.filter((p): p is string => typeof p === 'string' && p.length <= 64).slice(0, 16)
    : []
  const commands = Array.isArray(v.commands)
    ? v.commands.filter((c): c is string => typeof c === 'string' && c.length <= 64).slice(0, 32)
    : []
  const auth = (v.auth as Record<string, unknown> | null | undefined)?.method
  const view: CliCatalogVersion = {
    version,
    size,
    platforms,
    supported: platforms.includes('any') || platforms.includes(currentPlatform()),
    commands,
  }
  const minNode = readString(v.minNode, 32)
  if (minNode) view.minNode = minNode
  if (v.sideEffects === 'read-only' || v.sideEffects === 'writes') view.sideEffects = v.sideEffects
  if (auth === 'none' || auth === 'env-ref' || auth === 'external-login') view.auth = auth
  const publishedAt = readString(v.publishedAt, 64)
  if (publishedAt) view.publishedAt = publishedAt
  return {
    view,
    archiveSha256,
    integrity,
    downloadUrl,
    signature: parseCatalogSignature(v.signature),
    guide: parseGuide(v.guide),
  }
}

function parseTool(raw: unknown): CatalogToolRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const id = readString(t.id, 128)
  if (!id || !ID_PATTERN.test(id)) return null
  const versions = Array.isArray(t.versions)
    ? t.versions.map(parseVersion).filter((v): v is CatalogVersionRecord => v !== null)
    : []
  // A tool without approved versions is kept: its revocation (or absence of
  // one) still tells installed copies what to do.
  const latest = readString(t.latest, 64)
  return {
    id,
    displayName: readString(t.displayName) ?? id,
    source: readString(t.source, 32) ?? '',
    revoked: t.revoked === true,
    latest: latest && versions.some(v => v.view.version === latest) ? latest : versions[0]?.view.version ?? '',
    versions,
    skill: parseGuide(t.skill),
  }
}

/** Validate a catalog body; malformed tools and versions are dropped, never guessed. */
export function parseCliCatalog(raw: unknown): CatalogToolRecord[] {
  if (!raw || typeof raw !== 'object') throw new Error('The store returned an invalid CLI catalog')
  const body = raw as Record<string, unknown>
  if (body.schema !== CLI_CATALOG_SCHEMA) throw new Error('The store returned an unsupported CLI catalog')
  if (!Array.isArray(body.tools)) return []
  const seen = new Set<string>()
  const tools: CatalogToolRecord[] = []
  for (const item of body.tools) {
    const tool = parseTool(item)
    if (!tool || seen.has(tool.id)) continue
    seen.add(tool.id)
    tools.push(tool)
  }
  return tools
}

function toView(tool: CatalogToolRecord, state: CliToolState | null): CliCatalogTool {
  const installed = state?.tools[tool.id]
  return {
    id: tool.id,
    displayName: tool.displayName,
    source: tool.source,
    revoked: tool.revoked,
    latest: tool.latest,
    versions: tool.versions.map(v => v.view),
    installed: installed
      ? {
          current: installed.current,
          versions: Object.keys(installed.versions),
          revoked: installed.revoked,
        }
      : null,
  }
}

/**
 * Fetch the catalog and apply its status to installed tools. Null when the
 * primary source has no catalog endpoint or does not serve one — then nothing
 * is applied, so an unavailable catalog never marks tools delisted.
 */
async function loadCatalog(): Promise<CatalogToolRecord[] | null> {
  const endpoint = primaryEndpoint('fetchCliCatalog')
  if (!endpoint) return null
  const raw = await endpoint.call(endpoint.source, await requireAuth())
  if (raw == null) return null
  const tools = parseCliCatalog(raw)
  await applyStatus(tools)
  return tools
}

/** What `applyCatalogStatus` needs from a parsed catalog; exported for tests. */
export function catalogStatusOf(tools: CatalogToolRecord[]): CatalogToolStatus[] {
  return tools.map(tool => {
    const guides: NonNullable<CatalogToolStatus['guides']> = {}
    for (const v of tool.versions) {
      if (v.guide === 'invalid') {
        console.warn('[CliCatalog] Guide override ignored: malformed', { tool: `${tool.id}@${v.view.version}` })
        continue
      }
      guides[v.view.version] = { integrity: v.integrity, override: v.guide }
    }
    const status: CatalogToolStatus = { id: tool.id, revoked: tool.revoked, versions: tool.versions.map(v => v.view.version), guides }
    // A malformed skill leaves preset copies as they are; a missing one clears it.
    if (tool.skill === 'invalid') console.warn('[CliCatalog] Tool skill ignored: malformed', { tool: tool.id })
    else status.skill = tool.skill
    return status
  })
}

async function applyStatus(tools: CatalogToolRecord[]): Promise<void> {
  const changed = await applyCatalogStatus(catalogStatusOf(tools))
  if (changed.length > 0) console.log('[CliCatalog] Catalog status updated for', changed)
}

/** The catalog merged with installed state; empty when the store serves none. */
export async function fetchCliCatalog(): Promise<CliCatalog> {
  const tools = await loadCatalog()
  if (!tools) return { tools: [] }
  const state = await readCliToolState()
  // Status-only entries (no approved version) have nothing to offer here.
  return { tools: tools.filter(tool => tool.versions.length > 0).map(tool => toView(tool, state)) }
}

/**
 * Download one catalog version, verify it and make it current. The catalog is
 * read again first, so a version revoked or withdrawn since the list was shown
 * is refused rather than installed from a stale view.
 */
export async function installCliTool(request: { id: string; version: string }): Promise<CliCatalogTool> {
  const tools = await loadCatalog()
  if (!tools) throw new Error('This store does not offer CLI tools')
  const tool = tools.find(t => t.id === request.id)
  if (!tool) throw new Error('This CLI tool is not in the store catalog')
  if (tool.revoked) throw new Error('This CLI tool has been revoked by an administrator')
  const entry = tool.versions.find(v => v.view.version === request.version)
  if (!entry) throw new Error('This CLI version is no longer available from the store')
  if (!entry.view.supported) throw new Error('This CLI version does not support this device')
  const expectation = {
    id: tool.id,
    version: entry.view.version,
    archiveSha256: entry.archiveSha256,
    integrity: entry.integrity,
    signature: entry.signature,
  }
  // Checked before downloading: a refused signature costs no transfer.
  await verifyCatalogSignature(expectation)

  const endpoint = primaryEndpoint('downloadCliPackage')
  if (!endpoint) throw new Error('This store does not offer CLI tools')
  const bytes = await endpoint.call(
    endpoint.source,
    entry.downloadUrl,
    await requireAuth(),
    DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes,
  )
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== entry.archiveSha256) {
    throw new Error('The downloaded CLI package does not match the store catalog')
  }

  const dir = await mkdtemp(join(tmpdir(), 'halo-cli-download-'))
  try {
    const archive = join(dir, 'package.hcli')
    await writeFile(archive, bytes)
    await installCatalogPackage(archive, expectation)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  // The version was not installed when the catalog was applied above; give it its guide now.
  await applyStatus(tools)
  return toView(tool, await readCliToolState())
}

/**
 * Background revocation refresh. Silent when there is nothing to ask or no one
 * signed in; any failure is logged and leaves the flags as they were.
 */
export async function syncCliCatalogRevocations(): Promise<void> {
  if (!primaryEndpoint('fetchCliCatalog')) return
  try {
    if (!(await getStoreIdentityToken())) return
    await loadCatalog()
  } catch (error) {
    console.warn('[CliCatalog] Revocation sync skipped:', error instanceof Error ? error.message : String(error))
  }
}
