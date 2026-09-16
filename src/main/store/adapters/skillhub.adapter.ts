/**
 * SkillHub Adapter (Proxy Mode)
 *
 * Fetches from https://api.skillhub.cn — China-based OpenClaw Skills mirror
 * with 100,000+ community skills.
 *
 * API overview:
 *   List:    GET /api/skills?page=N&pageSize=1..100&keyword=...&category=...
 *   Detail:  GET /api/v1/skills/{slug}/files  → file list + version
 *   Content: GET /api/v1/skills/{slug}/file?path=...&version=...  → 302 to the CDN
 *
 * The list endpoint ignores unknown query parameters silently but rejects an
 * unknown `category` with HTTP 400, so every parameter name and category key
 * below is the server's own vocabulary, never Halo's.
 *
 * File content is fetched through the `/file` redirect endpoint rather than a
 * hand-built CDN URL. SkillHub's storage layout is an implementation detail —
 * observed as a flat `/skills/{slug}/...` path for older skills, and
 * `/skills/{numericId}/{slug}/...` or `/orgs/{orgId}/{slug}/...` for newer
 * ones — and only this endpoint is guaranteed to resolve it.
 *
 * Proxy strategy: 100k+ skills — queries forwarded on demand, results not cached in SQLite.
 */

import { fetchWithTimeout } from './halo.adapter'
import type { RegistrySource, RegistryEntry, StoreCategory, StoreQueryParams } from '../../../shared/store/store-types'
import type { AppSpec, SkillSpec } from '../../apps/spec/schema'
import type { RegistryAdapter, AdapterQueryResult } from './types'

// ── External API types ─────────────────────────────────────────────────────

interface SkillHubSkill {
  slug: string
  name: string
  description?: string
  description_zh?: string
  category?: string
  tags?: string[] | null
  ownerName?: string
  version?: string
  stars?: number
  installs?: number
  downloads?: number
  source?: string
  iconUrl?: string | null
  homepage?: string
  created_at?: number
  updated_at?: number
}

interface SkillHubListResponse {
  code: number
  message: string
  data: {
    skills: SkillHubSkill[]
    total: number
  }
}

interface SkillHubFileEntry {
  path: string
  sha256?: string
  size?: number
}

interface SkillHubFilesResponse {
  count: number
  version: string
  files: SkillHubFileEntry[]
}

// ── Constants ──────────────────────────────────────────────────────────────

const API_BASE = 'https://api.skillhub.cn'
const MAX_PAGE_SIZE = 100
const USER_AGENT = 'Halo-Store/1.0'
const DEFAULT_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': USER_AGENT,
}
/** File bodies are markdown/scripts, so the JSON Accept of the API calls is wrong here. */
const FILE_HEADERS = { 'User-Agent': USER_AGENT }

// ── Category vocabulary ────────────────────────────────────────────────────

/**
 * SkillHub's own taxonomy (`GET /api/v1/categories`) projected onto Halo's.
 * Keys are the server's `category` values verbatim — the API rejects anything
 * else with HTTP 400, so this table is also the allow-list for outbound
 * requests.
 *
 * Both directions read from this one table, which keeps display and filtering
 * coherent: `STORE_CATEGORY_TO_SKILLHUB` is the exact preimage, so a skill
 * shown under a chip is always returned by that chip's query.
 *
 * `pay-skill` is listed by that endpoint but is a cross-cutting paid flag, not
 * a category — filtering on it returns skills of every other category. Keeping
 * it would both mislabel those skills and make two chips return the same skill,
 * which the fanned-out pagination below assumes cannot happen.
 */
const SKILLHUB_CATEGORY_TO_STORE: Record<string, StoreCategory> = {
  'office-efficiency': 'productivity',
  'business-ops': 'productivity',
  'content-creation': 'content',
  'design-media': 'content',
  'dev-programming': 'dev-tools',
  'ai-agent': 'dev-tools',
  'it-ops-security': 'dev-tools',
  'data-analysis': 'data',
  'knowledge-management': 'data',
  'education': 'other',
  'professional': 'other',
  'life-service': 'other',
}

/**
 * Halo category → the SkillHub keys it covers. Halo's `shopping`, `news` and
 * `social` have no counterpart and are absent, which the query path reads as
 * "this source has nothing here" and answers without a request.
 */
const STORE_CATEGORY_TO_SKILLHUB = ((): Map<string, string[]> => {
  const index = new Map<string, string[]>()
  for (const [key, category] of Object.entries(SKILLHUB_CATEGORY_TO_STORE)) {
    const bucket = index.get(category)
    if (bucket) bucket.push(key)
    else index.set(category, [key])
  }
  return index
})()

// ── Helpers ────────────────────────────────────────────────────────────────

/** A category SkillHub adds after this release lands falls into the catch-all. */
function mapCategory(cat?: string): StoreCategory {
  if (!cat) return 'other'
  return SKILLHUB_CATEGORY_TO_STORE[cat] ?? 'other'
}

/** Convert a SkillHub skill record to a Halo RegistryEntry */
function toEntry(skill: SkillHubSkill): RegistryEntry | null {
  if (!skill.slug || !skill.name) return null
  return {
    slug: skill.slug,
    name: skill.name,
    version: skill.version ?? '1.0',
    author: skill.ownerName ?? 'community',
    description: skill.description ?? skill.name,
    type: 'skill',
    format: 'bundle',
    path: skill.slug,
    category: mapCategory(skill.category),
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    icon: skill.iconUrl ?? undefined,
    created_at: skill.created_at ? new Date(skill.created_at).toISOString() : undefined,
    updated_at: skill.updated_at ? new Date(skill.updated_at).toISOString() : undefined,
    i18n: skill.description_zh
      ? { 'zh-CN': { description: skill.description_zh } }
      : undefined,
    meta: {
      rank: typeof skill.stars === 'number' ? skill.stars : undefined,
      installs: skill.installs,
      source: skill.source,
      homepage: skill.homepage,
    },
  }
}

/** One page of one SkillHub category (or of the whole catalog when unscoped). */
async function fetchPage(
  page: number,
  pageSize: number,
  search: string | undefined,
  category: string | null,
): Promise<{ items: RegistryEntry[]; total: number; hasMore: boolean }> {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  if (search) qs.set('keyword', search)
  if (category) qs.set('category', category)

  const response = await fetchWithTimeout(`${API_BASE}/api/skills?${qs}`, { headers: DEFAULT_HEADERS })
  if (!response.ok) {
    throw new Error(`SkillHub API error HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json() as SkillHubListResponse
  if (data.code !== 0 || !data.data) {
    throw new Error(`SkillHub API returned error: ${data.message ?? 'unknown'}`)
  }

  const items: RegistryEntry[] = []
  for (const skill of data.data.skills) {
    const entry = toEntry(skill)
    if (entry) items.push(entry)
  }

  const total = data.data.total
  return { items, total, hasMore: page * pageSize < total }
}

/** Resolve the current version + file list for a skill via the files manifest. */
async function fetchFilesManifest(slug: string): Promise<SkillHubFilesResponse> {
  const filesUrl = `${API_BASE}/api/v1/skills/${encodeURIComponent(slug)}/files`
  const filesRes = await fetchWithTimeout(filesUrl, { headers: DEFAULT_HEADERS })
  if (!filesRes.ok) {
    throw new Error(`SkillHub files API error HTTP ${filesRes.status} for "${slug}"`)
  }
  const filesData = await filesRes.json() as SkillHubFilesResponse
  if (!filesData.version) {
    throw new Error(`SkillHub files API returned no version for "${slug}"`)
  }
  return filesData
}

async function downloadFile(slug: string, version: string, path: string): Promise<string> {
  const qs = new URLSearchParams({ path, version })
  const url = `${API_BASE}/api/v1/skills/${encodeURIComponent(slug)}/file?${qs}`
  const res = await fetchWithTimeout(url, { headers: FILE_HEADERS })
  if (!res.ok) {
    throw new Error(`SkillHub: failed to download "${path}" of "${slug}" v${version}: HTTP ${res.status}`)
  }
  return await res.text()
}

/**
 * Download every file listed in the manifest. A skill is only usable with all
 * of its files, so any miss (or an unsafe upstream path) fails the install —
 * previously only SKILL.md was fetched and the rest were silently dropped.
 */
async function downloadSkillFiles(slug: string): Promise<Record<string, string>> {
  const manifest = await fetchFilesManifest(slug)
  const paths = (manifest.files ?? []).map(f => f.path).filter(Boolean)
  if (paths.length === 0) {
    throw new Error(`SkillHub manifest lists no files for "${slug}"`)
  }
  const result: Record<string, string> = {}
  await Promise.all(paths.map(async (path) => {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`SkillHub manifest for "${slug}" contains unsafe path "${path}"`)
    }
    result[path] = await downloadFile(slug, manifest.version, path)
  }))
  if (!result['SKILL.md']) {
    throw new Error(`SkillHub skill "${slug}" has no SKILL.md`)
  }
  return result
}

/** Download just SKILL.md (detail-page document — no need to pull the whole skill). */
async function downloadSkillMd(slug: string): Promise<string> {
  const manifest = await fetchFilesManifest(slug)
  return downloadFile(slug, manifest.version, 'SKILL.md')
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class SkillHubAdapter implements RegistryAdapter {
  readonly strategy = 'proxy' as const

  async query(_source: RegistrySource, params: StoreQueryParams): Promise<AdapterQueryResult> {
    const pageSize = Math.min(params.pageSize || 24, MAX_PAGE_SIZE)
    const t0 = performance.now()

    // `category` takes one SkillHub key per request, so a Halo chip covering
    // several of them is fanned out and the page split evenly. The sub-streams
    // are disjoint and each paginates independently, so the merge stays
    // complete and duplicate-free across pages.
    const streams: Array<string | null> = params.category
      ? STORE_CATEGORY_TO_SKILLHUB.get(params.category) ?? []
      : [null]

    if (streams.length === 0) {
      console.log(`[SkillHubAdapter] category "${params.category}" not served by SkillHub — 0 requests`)
      return { items: [], total: 0, hasMore: false }
    }

    // A fan-out multiplies the chance that some request fails, so one flaky
    // sub-stream must not cost the user the whole page. What the survivors
    // returned is served; what the failures would have counted is not knowable,
    // so `total` is marked partial rather than passed off as the catalog.
    const streamSize = Math.max(1, Math.ceil(pageSize / streams.length))
    const settled = await Promise.allSettled(
      streams.map(category => fetchPage(params.page, streamSize, params.search, category))
    )

    const pages = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
    const failures = settled.flatMap(r =>
      r.status === 'rejected' ? [(r.reason as Error).message] : []
    )
    if (pages.length === 0) {
      throw new Error(`SkillHub query failed on every category stream: ${failures.join('; ')}`)
    }

    // Round-robin: each stream is ranked by SkillHub, so taking one from each
    // in turn puts the strongest result of every covered category up front.
    const items: RegistryEntry[] = []
    const deepest = Math.max(...pages.map(p => p.items.length))
    for (let i = 0; i < deepest; i++) {
      for (const page of pages) {
        if (i < page.items.length) items.push(page.items[i])
      }
    }

    const total = pages.reduce((sum, p) => sum + p.total, 0)
    const hasMore = pages.some(p => p.hasMore)
    const partial =
      failures.length > 0
        ? `${failures.length}/${streams.length} SkillHub category streams failed: ${failures.join('; ')}`
        : undefined

    const dt = performance.now() - t0
    console.log(
      `[SkillHubAdapter] query page ${params.page} category=${params.category ?? '-'} streams=${pages.length}/${streams.length}: ${items.length}/${total} skills (${dt.toFixed(0)}ms)`
    )
    if (partial) console.warn(`[SkillHubAdapter] ${partial}`)

    return { items, total, hasMore, partial }
  }

  async fetchSpec(_source: RegistrySource, entry: RegistryEntry): Promise<AppSpec> {
    const slug = entry.slug
    const t0 = performance.now()

    const skill_files = await downloadSkillFiles(slug)

    const dt = performance.now() - t0
    console.log(
      `[SkillHubAdapter] fetched spec for "${slug}" (${Object.keys(skill_files).length} files, ${dt.toFixed(0)}ms)`
    )

    const spec: SkillSpec = {
      spec_version: '1',
      name: entry.name,
      type: 'skill',
      version: entry.version,
      description: entry.description,
      author: entry.author,
      skill_files,
      store: {
        slug: entry.slug,
        registry_id: _source.id,
      },
    }

    return spec
  }

  async fetchDocument(_source: RegistrySource, entry: RegistryEntry): Promise<string | null> {
    try {
      return await downloadSkillMd(entry.slug)
    } catch (err) {
      console.log(`[SkillHubAdapter] No document for "${entry.slug}": ${(err as Error).message}`)
      return null
    }
  }
}
