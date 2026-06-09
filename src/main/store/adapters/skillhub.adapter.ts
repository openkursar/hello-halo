/**
 * SkillHub Adapter (Proxy Mode)
 *
 * Fetches from https://api.skillhub.cn — China-based OpenClaw Skills mirror
 * with 33,000+ community skills.
 *
 * API overview:
 *   List:    GET /api/skills?page=N&pageSize=24&keyword=...
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

// ── Adapter ────────────────────────────────────────────────────────────────

export class SkillHubAdapter implements RegistryAdapter {
  readonly strategy = 'proxy' as const

  async query(_source: RegistrySource, params: StoreQueryParams): Promise<AdapterQueryResult> {
    const pageSize = Math.min(params.pageSize || 24, 100)
    const t0 = performance.now()

    const searchParam = params.search ? `&keyword=${encodeURIComponent(params.search)}` : ''
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

    // Step 1: Get the files manifest to resolve the current version
    const filesUrl = `${API_BASE}/api/v1/skills/${slug}/files`
    const filesRes = await fetchWithTimeout(filesUrl, { headers: DEFAULT_HEADERS })
    if (!filesRes.ok) {
      throw new Error(`SkillHub files API error HTTP ${filesRes.status} for "${slug}"`)
    }

    const filesData = await filesRes.json() as SkillHubFilesResponse
    const version = filesData.version
    if (!version) {
      throw new Error(`SkillHub files API returned no version for "${slug}"`)
    }

    // Step 2: Download SKILL.md from Tencent COS (open CORS, no auth)
    const skillMdPath = 'SKILL.md'
    const skillMdUrl = `${COS_BASE}/skills/${slug}/${version}/files/${skillMdPath}`
    const mdRes = await fetchWithTimeout(skillMdUrl, {
      headers: { 'User-Agent': 'Halo-Store/1.0' },
    })

    if (!mdRes.ok) {
      throw new Error(
        `SkillHub: failed to download SKILL.md for "${slug}" v${version}: HTTP ${mdRes.status}`
      )
    }

    const skillMdContent = await mdRes.text()

    const dt = performance.now() - t0
    console.log(`[SkillHubAdapter] fetched spec for "${slug}" v${version} (${dt.toFixed(0)}ms)`)

    const spec: SkillSpec = {
      spec_version: '1',
      name: entry.name,
      type: 'skill',
      version: entry.version,
      description: entry.description,
      author: entry.author,
      skill_files: {
        'SKILL.md': skillMdContent,
      },
      store: {
        slug: entry.slug,
        registry_id: _source.id,
      },
    }

    return spec
  }
}
