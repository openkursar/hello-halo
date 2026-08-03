/**
 * Registry Adapter Interface
 *
 * Each adapter is responsible for fetching and normalising data from one
 * external registry protocol into the canonical RegistryIndex / AppSpec
 * shapes used by the rest of the store system.
 *
 * Adding a new source = adding one file that implements this interface.
 * No other core logic needs to change.
 *
 * Two data strategies:
 *   - mirror:  Small/static sources. Full index downloaded, stored in SQLite.
 *   - proxy:   Large API sources. Queries forwarded on demand, results cached.
 *
 * Beyond the catalog, the interface also declares the optional backend surface
 * (handshake, install ledger, collections, creator publications, ops-managed
 * page documents). Optional means the SOURCE decides what it implements — the
 * composition layer calls `adapter.x?.(source)` and a source without the method
 * costs zero requests. See DESIGN.md §2.
 */

import type {
  RegistrySource,
  RegistryIndex,
  RegistryEntry,
  StoreQueryParams,
  ServerFeatures,
  InstallOrder,
  InstallGrant,
} from '../../../shared/store/store-types'
import type { AppSpec, SkillSpec } from '../../apps/spec/schema'

/** Result of a proxy query to a remote API source */
export interface AdapterQueryResult {
  items: RegistryEntry[]
  total?: number
  hasMore: boolean
}

/**
 * Caller-supplied credential for identity-bound endpoints. Adapters never
 * resolve identity themselves: which provider mints the token is a
 * deployment concern owned by the composition layer (backend/identity).
 */
export interface RegistryAuth {
  token: string
}

export interface RegistryAdapter {
  /** Data strategy: 'mirror' for full-index sources, 'proxy' for API sources */
  readonly strategy: 'mirror' | 'proxy'

  /**
   * Mirror mode: download the full index from the source.
   * Only required when strategy = 'mirror'.
   */
  fetchIndex?(source: RegistrySource): Promise<RegistryIndex>

  /**
   * Proxy mode: query the source API with pagination.
   * Only required when strategy = 'proxy'.
   */
  query?(source: RegistrySource, params: StoreQueryParams): Promise<AdapterQueryResult>

  /**
   * Fetch (or construct) the full AppSpec for a single registry entry.
   * All adapters must implement this.
   *
   * @param onProgress Optional callback fired as files are downloaded.
   *                   (filesComplete, filesTotal, currentFile)
   *                   Only meaningful for adapters that download multiple files
   *                   (e.g. ClaudeSkillsAdapter). Other adapters may ignore it.
   */
  fetchSpec(
    source: RegistrySource,
    entry: RegistryEntry,
    onProgress?: (filesComplete: number, filesTotal: number, currentFile: string) => void,
  ): Promise<AppSpec>

  /**
   * Fetch the human-readable document (SKILL.md / README) for a single entry,
   * for display on the store detail page. Must be cheap: a single static
   * fetch, no API-quota-consuming calls.
   *
   * Returns the markdown text, or null when the source has no document for
   * this entry (callers hide the docs section). Adapters without a document
   * concept leave this unimplemented.
   */
  fetchDocument?(source: RegistrySource, entry: RegistryEntry): Promise<string | null>

  /**
   * Fetch bundled skill files for skills declared with `bundled: true` in `requires.skills`.
   *
   * Only implemented by adapters whose package format supports co-located skill directories
   * (e.g. HaloAdapter). Other adapters leave this unimplemented.
   *
   * Each skill entry includes its `files` list (declared in spec.yaml) so the adapter
   * can fetch them directly via static URLs — no directory listing or API calls needed.
   *
   * @param skills - Bundled skill declarations with file lists
   * @returns Map of skillId → SkillSpec with skill_files populated
   */
  fetchBundledSkills?(
    source: RegistrySource,
    entry: RegistryEntry,
    skills: Array<{ id: string; files?: string[] }>,
  ): Promise<Map<string, SkillSpec>>

  // ── Backend surface (optional) ───────────────────────────────────────────

  /**
   * Handshake: which store surfaces this backend advertises. Returns null
   * when the source has no such endpoint.
   *
   * The result gates UI surfaces ONLY. It must never gate whether another driver
   * method is invoked — the endpoints mount on independent server-side
   * conditions, so a reachable ledger can coexist with an absent handshake.
   * See DESIGN.md §3.1.
   */
  serverFeatures?(source: RegistrySource): Promise<ServerFeatures | null>

  /**
   * Open an install order against the source's ledger and receive the bundle
   * location to download from. Three-state contract (DESIGN.md §3.5):
   *   grant → authorised · null → permanently refused / no endpoint · throw → retryable fault
   */
  openInstallOrder?(
    source: RegistrySource,
    order: InstallOrder,
    auth?: RegistryAuth,
  ): Promise<InstallGrant | null>

  /** Curated scene collections. Unauthenticated. Payload validated by the caller. */
  fetchCollections?(source: RegistrySource): Promise<unknown[]>

  /** The authenticated creator's own published versions. Payload validated by the caller. */
  fetchMyPublications?(source: RegistrySource, auth: RegistryAuth): Promise<unknown[]>

  /** Take down one of the caller's own published apps. */
  unpublish?(source: RegistrySource, slug: string, auth: RegistryAuth): Promise<void>

  /** Re-list one of the caller's own taken-down apps. */
  relist?(source: RegistrySource, slug: string, auth: RegistryAuth): Promise<void>

  // ── Page-level documents (optional) ──────────────────────────────────────
  // One chip row, one discover page: merging N answers has no meaning, so only
  // the primary source's document is adopted. See DESIGN.md §2.1.

  /** Ops-managed category taxonomy. Payload validated by the caller. */
  fetchPageTaxonomy?(source: RegistrySource): Promise<unknown | null>

  /** Ops-managed discover-page layout. Payload validated by the caller. */
  fetchPageLayout?(source: RegistrySource): Promise<unknown | null>
}
