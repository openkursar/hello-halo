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
 */

import type { RegistrySource, RegistryIndex, RegistryEntry, StoreQueryParams } from '../../../shared/store/store-types'
import type { AppSpec, SkillSpec } from '../../apps/spec/schema'

/** Result of a proxy query to a remote API source */
export interface AdapterQueryResult {
  items: RegistryEntry[]
  total?: number
  hasMore: boolean
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
}
