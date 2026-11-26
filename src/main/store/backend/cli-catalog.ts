/**
 * CLI tool catalog — the administrator-reviewed command-line tools the primary
 * source offers this account, merged with what is installed on this device.
 *
 * Primary source only, like "my publications": the catalog and its bundles
 * are read with the build's account token, and that token belongs to one
 * store. Listing the catalog never fetches a bundle; a version is downloaded
 * when the user installs it, or by the delivery pass (cli-catalog-sync.ts),
 * which also brings installed versions up to their current bundle revision.
 * A read sends the previous ETag, so an unchanged catalog costs no body.
 *
 * The catalog (`halo.cli.catalog/2`) names one delivery bundle per version:
 * the approved `.hcli` and its skill in one zip (see cli-tools bundle.ts).
 * Every successful read applies the catalog's status to installed tools
 * (`applyCatalogStatus`): revocation, delisting of catalog tools it no longer
 * lists, withdrawn versions and available updates. Installing re-reads the
 * catalog first and refuses a revoked tool or a version the catalog no longer
 * lists, then hands the downloaded bundle to cli-tools, which checks it
 * against the catalog's reference before anything is published.
 *
 * See DESIGN.md §3.13.
 */

import { getPrimaryRegistry } from '../registry.service'
import { getAdapter } from '../adapters'
import { getStoreIdentityToken } from './identity'
import {
  BUNDLE_MAX_BYTES,
  applyCatalogStatus,
  installCatalogBundle,
  readCliToolState,
} from '../../services/cli-tools'
import type { BundleReference, CatalogToolStatus, CliToolState } from '../../services/cli-tools'
import { STORE_NOT_SIGNED_IN } from '../../../shared/store/store-types'
import type {
  CliCatalog,
  CliCatalogTool,
  CliCatalogVersion,
  RegistrySource,
} from '../../../shared/store/store-types'
import type { RegistryAdapter, RegistryAuth } from '../adapters/types'

export const CLI_CATALOG_SCHEMA = 'halo.cli.catalog/2'

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256_HEX = /^[0-9a-f]{64}$/

/** A catalog version with the fields only the main process may see. */
export interface CatalogVersionRecord {
  view: CliCatalogVersion
  /** The version's current delivery bundle. */
  bundle: BundleReference & { url: string }
}

export interface CatalogToolRecord {
  id: string
  displayName: string
  source: string
  revoked: boolean
  /** Empty when the tool has no approved version (a status-only entry). */
  latest: string
  versions: CatalogVersionRecord[]
  /** Delivered to every device without asking (see cli-catalog-sync.ts). */
  autoInstall: boolean
}

/** The last catalog read and its ETag, per source, so an unchanged catalog is not sent again. */
let cached: { source: string; validator: string; tools: CatalogToolRecord[] } | null = null

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

function parseBundle(raw: unknown, id: string, version: string): CatalogVersionRecord['bundle'] | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const { revision, sha256, size } = b
  const url = readString(b.url, 512)
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > BUNDLE_MAX_BYTES) return null
  if (!url) return null
  return { id, version, revision, sha256, size, url }
}

function parseVersion(raw: unknown, id: string): CatalogVersionRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const version = readString(v.version, 64)
  if (!version || !VERSION_PATTERN.test(version)) return null
  const bundle = parseBundle(v.bundle, id, version)
  if (!bundle) return null
  const platforms = Array.isArray(v.platforms)
    ? v.platforms.filter((p): p is string => typeof p === 'string' && p.length <= 64).slice(0, 16)
    : []
  const commands = Array.isArray(v.commands)
    ? v.commands.filter((c): c is string => typeof c === 'string' && c.length <= 64).slice(0, 32)
    : []
  const auth = (v.auth as Record<string, unknown> | null | undefined)?.method
  const view: CliCatalogVersion = {
    version,
    size: bundle.size,
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
  return { view, bundle }
}

function parseTool(raw: unknown): CatalogToolRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const id = readString(t.id, 128)
  if (!id || !ID_PATTERN.test(id)) return null
  const versions = Array.isArray(t.versions)
    ? t.versions.map(v => parseVersion(v, id)).filter((v): v is CatalogVersionRecord => v !== null)
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
    autoInstall: t.autoInstall === true,
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

/** Whether the primary source can serve a CLI catalog at all; no request is made. */
export function hasCliCatalogSource(): boolean {
  return primaryEndpoint('fetchCliCatalog') !== null
}

async function readCatalog(): Promise<CatalogToolRecord[] | null> {
  const endpoint = primaryEndpoint('fetchCliCatalog')
  if (!endpoint) return null
  const key = `${endpoint.source.id} ${endpoint.source.url}`
  const validator = cached?.source === key ? cached.validator : undefined
  const result = await endpoint.call(endpoint.source, await requireAuth(), validator)
  if (result.status === 'absent') {
    cached = null
    return null
  }
  if (result.status === 'unchanged') {
    if (cached?.source === key) return cached.tools
    throw new Error('The store answered an unconditional CLI catalog read as unchanged')
  }
  const tools = parseCliCatalog(result.document)
  cached = result.validator ? { source: key, validator: result.validator, tools } : null
  return tools
}

/**
 * Fetch the catalog and apply its status to installed tools. Null when the
 * primary source has no catalog endpoint or does not serve one — then nothing
 * is applied, so an unavailable catalog never marks tools delisted.
 */
export async function loadCatalog(): Promise<{ tools: CatalogToolRecord[]; changed: string[] } | null> {
  const tools = await readCatalog()
  if (!tools) return null
  return { tools, changed: await applyStatus(tools) }
}

/** What `applyCatalogStatus` needs from a parsed catalog; exported for tests. */
export function catalogStatusOf(tools: CatalogToolRecord[]): CatalogToolStatus[] {
  return tools.map(tool => ({
    id: tool.id,
    revoked: tool.revoked,
    versions: Object.fromEntries(tool.versions.map(v => [v.view.version, v.bundle.sha256])),
    ...(tool.autoInstall ? { autoInstall: true } : {}),
  }))
}

export async function applyStatus(tools: CatalogToolRecord[]): Promise<string[]> {
  const changed = await applyCatalogStatus(catalogStatusOf(tools))
  if (changed.length > 0) console.log('[CliCatalog] Catalog status updated for', changed)
  return changed
}

/** The catalog merged with installed state; empty when the store serves none. */
export async function fetchCliCatalog(): Promise<CliCatalog> {
  const tools = (await loadCatalog())?.tools
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
  const tools = (await loadCatalog())?.tools
  if (!tools) throw new Error('This store does not offer CLI tools')
  const tool = tools.find(t => t.id === request.id)
  if (!tool) throw new Error('This CLI tool is not in the store catalog')
  if (tool.revoked) throw new Error('This CLI tool has been revoked by an administrator')
  const entry = tool.versions.find(v => v.view.version === request.version)
  if (!entry) throw new Error('This CLI version is no longer available from the store')
  if (!entry.view.supported) throw new Error('This CLI version does not support this device')
  await downloadAndInstall(entry)
  // The version was not installed when the catalog was applied above; give it its flags now.
  await applyStatus(tools)
  return toView(tool, await readCliToolState())
}

/**
 * Download one listed version's bundle and install it: the CLI and its skill
 * arrive together and become current, or only the skill changes when that CLI
 * content is already installed. Any refusal leaves the installed versions as
 * they were.
 */
export async function downloadAndInstall(entry: CatalogVersionRecord): Promise<void> {
  const endpoint = primaryEndpoint('downloadCliPackage')
  if (!endpoint) throw new Error('This store does not offer CLI tools')
  const { url, ...ref } = entry.bundle
  const bytes = await endpoint.call(endpoint.source, url, await requireAuth(), Math.min(ref.size, BUNDLE_MAX_BYTES))
  await installCatalogBundle(bytes, ref)
}
