/**
 * SkillHub Adapter (Proxy Mode)
 *
 * Fetches from https://api.skillhub.cn — China-based OpenClaw Skills mirror
 * with 33,000+ community skills.
 *
 * API overview:
 *   List:    GET /api/skills?page=N&pageSize=24&search=...
 *   Detail:  GET /api/v1/skills/{slug}/files  → file list + version
 *   Content: GET https://skillhub-1388575217.cos.accelerate.myqcloud.com/skills/{slug}/{version}/files/SKILL.md
 *
 * Proxy strategy: 33k+ skills — queries forwarded on demand, results not cached in SQLite.
 * Only SKILL.md is downloaded at install time (JS hooks are OpenClaw-specific and ignored).
 */

import { fetchWithTimeout } from './halo.adapter'
import type { RegistrySource, RegistryEntry, StoreQueryParams } from '../../../shared/store/store-types'
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
const COS_BASE = 'https://skillhub-1388575217.cos.accelerate.myqcloud.com'
const DEFAULT_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Halo-Store/1.0',
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Map SkillHub category strings to Halo store categories.
 * SkillHub uses camelCase/hyphen categories; Halo has a fixed set.
 */
function mapCategory(cat?: string): string {
  if (!cat) return 'other'
  const c = cat.toLowerCase()
  if (c.includes('developer') || c.includes('coding') || c.includes('code')) return 'dev-tools'
  if (c.includes('data') || c.includes('analysis')) return 'data'
  if (c.includes('content') || c.includes('writing') || c.includes('creation')) return 'content'
  if (c.includes('productivity') || c.includes('task') || c.includes('workflow')) return 'productivity'
  if (c.includes('social') || c.includes('chat') || c.includes('message')) return 'social'
  if (c.includes('news') || c.includes('search') || c.includes('web')) return 'news'
  return 'other'
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

/** Resolve the current version + file list for a skill via the files manifest. */
async function fetchFilesManifest(slug: string): Promise<SkillHubFilesResponse> {
  const filesUrl = `${API_BASE}/api/v1/skills/${slug}/files`
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
  const res = await fetchWithTimeout(`${COS_BASE}/skills/${slug}/${version}/files/${path}`, {
    headers: { 'User-Agent': 'Halo-Store/1.0' },
  })
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
    const pageSize = Math.min(params.pageSize || 24, 100)
    const t0 = performance.now()

    const searchParam = params.search ? `&search=${encodeURIComponent(params.search)}` : ''
    const categoryParam = params.category ? `&category=${encodeURIComponent(params.category)}` : ''
    const url = `${API_BASE}/api/skills?page=${params.page}&pageSize=${pageSize}${searchParam}${categoryParam}`

    const response = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS })
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
    const hasMore = params.page * pageSize < total

    const dt = performance.now() - t0
    console.log(`[SkillHubAdapter] query page ${params.page}: ${items.length}/${total} skills (${dt.toFixed(0)}ms)`)

    return { items, total, hasMore }
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
