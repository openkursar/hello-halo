/**
 * Claude Skills Registry Adapter
 *
 * Fetches from https://majiayu000.github.io/claude-skill-registry-core
 * API: GET /featured.json  (100 curated skills)
 *
 * Data model:
 *   - `install` = "owner/repo/path/to/skill-folder/SKILL.md"
 *   - `path`    = path within repo (e.g. ".claude/skills/fix/SKILL.md")
 *   - `repo`    = "owner/repo"
 *   - `branch`  = hint only; we use GitHub Git Trees API to avoid N recursive calls
 *
 * fetchSpec uses the Git Trees API (1 GitHub API call) to list all files under
 * the skill directory, then downloads each file via raw.githubusercontent.com
 * (no API quota). Total cost: 1 GitHub API call per install, regardless of depth.
 *
 * Falls back to legacy recursive Contents API if the tree response is truncated
 * (repos > 100k entries — extremely rare for skill repos).
 */

import { fetchWithTimeout } from './halo.adapter'
import { sanitizeSlug } from './mcp-registry.adapter'
import type { AppSpec, SkillSpec } from '../../apps/spec/schema'
import type { RegistrySource, RegistryIndex, RegistryEntry } from '../../../shared/store/store-types'
import type { RegistryAdapter } from './types'

// ── External API types ─────────────────────────────────────────────────────

interface FeaturedSkillRecord {
  name: string
  description?: string
  repo: string        // "owner/repo"
  path: string        // path within repo, e.g. ".claude/skills/fix/SKILL.md"
  branch?: string
  category?: string
  tags?: string[]
  stars?: number
  install: string     // "owner/repo/path/to/SKILL.md"
  source?: string
}

interface FeaturedIndex {
  updated_at?: string
  count?: number
  skills: FeaturedSkillRecord[]
}

interface GitHubFileEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  download_url: string | null
}

interface GitTreeEntry {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  url: string
  size?: number
}

interface GitTreeResponse {
  sha: string
  url: string
  tree: GitTreeEntry[]
  truncated: boolean
}

// ── Types ──────────────────────────────────────────────────────────────────

/** Progress callback: (filesComplete, filesTotal, currentFile) */
export type SkillDownloadProgress = (filesComplete: number, filesTotal: number, currentFile: string) => void

// ── Helpers ────────────────────────────────────────────────────────────────

const GITHUB_HEADERS = {
  'User-Agent': 'Halo-Store/1.0',
  'Accept': 'application/vnd.github.v3+json',
}

/**
 * Build a user-friendly error from a GitHub API HTTP status code.
 */
function buildGitHubError(status: number, skillSlug: string, url: string): Error {
  if (status === 403 || status === 429) {
    return new Error(
      `GitHub API rate limit reached while fetching "${skillSlug}". ` +
      `You've used up the hourly limit for unauthenticated requests. ` +
      `Please wait a few minutes and try again.`
    )
  }
  if (status === 404) {
    return new Error(
      `Skill "${skillSlug}" was not found in the repository. ` +
      `It may have been moved or removed.`
    )
  }
  return new Error(
    `GitHub API error (HTTP ${status}) while fetching "${skillSlug}". ` +
    `Please check your network connection. (${url})`
  )
}

/**
 * Fetch all files under a skill directory using the Git Trees API.
 *
 * Uses exactly 1 GitHub API call to get the full repo tree, then filters
 * to the skill subdirectory and downloads each file via raw.githubusercontent.com
 * (which has no API rate limit).
 *
 * Falls back to legacy recursive listing if the tree response is truncated.
 */
async function collectSkillFilesViaTree(
  owner: string,
  repo: string,
  dirPath: string,
  branch: string,
  skillSlug: string,
  onProgress?: SkillDownloadProgress,
): Promise<Record<string, string>> {
  // 1 GitHub API call — full repo tree for this branch with recursive flag
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  const treeRes = await fetchWithTimeout(treeUrl, { headers: GITHUB_HEADERS })

  if (!treeRes.ok) {
    throw buildGitHubError(treeRes.status, skillSlug, treeUrl)
  }

  const treeData = await treeRes.json() as GitTreeResponse

  if (treeData.truncated) {
    // Very large repo — fall back to recursive Contents API (N API calls)
    console.warn(
      `[ClaudeSkillsAdapter] Git tree truncated for "${owner}/${repo}" ` +
      `(repo has too many files). Falling back to recursive Contents API.`
    )
    return collectSkillFilesLegacy(owner, repo, dirPath, '', skillSlug, onProgress)
  }

  // Filter to blob entries under dirPath/
  const prefix = dirPath + '/'
  const blobEntries = treeData.tree.filter(e => e.type === 'blob' && e.path.startsWith(prefix))

  if (blobEntries.length === 0) {
    throw new Error(
      `No files found for skill "${skillSlug}" at "${dirPath}" on branch "${branch}". ` +
      `The skill directory may be empty or the path may be incorrect.`
    )
  }

  const result: Record<string, string> = {}
  onProgress?.(0, blobEntries.length, '')

  // Download all files concurrently via raw.githubusercontent.com (no API quota)
  let completed = 0
  await Promise.all(blobEntries.map(async (entry) => {
    const relativePath = entry.path.slice(prefix.length)
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${entry.path}`

    const res = await fetchWithTimeout(rawUrl, { headers: { 'User-Agent': 'Halo-Store/1.0' } })
    if (!res.ok) {
      // A partial skill is broken at runtime — fail the install instead.
      throw new Error(`Failed to download "${relativePath}" of "${skillSlug}": HTTP ${res.status}`)
    }
    result[relativePath] = await res.text()
    completed++
    onProgress?.(completed, blobEntries.length, relativePath)
  }))

  return result
}

/**
 * Legacy recursive directory listing via GitHub Contents API.
 * Used only as fallback when the Git Trees API returns a truncated response.
 * Consumes 1 GitHub API call per directory level.
 */
async function collectSkillFilesLegacy(
  owner: string,
  repo: string,
  dirPath: string,
  prefix: string,
  skillSlug: string,
  onProgress?: SkillDownloadProgress,
): Promise<Record<string, string>> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`
  const response = await fetchWithTimeout(apiUrl, { headers: GITHUB_HEADERS })

  if (!response.ok) {
    throw buildGitHubError(response.status, skillSlug, apiUrl)
  }

  const listing = await response.json() as unknown
  if (!Array.isArray(listing)) {
    throw new Error(`GitHub API returned non-array listing for "${skillSlug}": ${apiUrl}`)
  }

  const entries = listing as GitHubFileEntry[]
  const result: Record<string, string> = {}

  await Promise.all(entries.map(async (entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.type === 'file') {
      if (!entry.download_url) {
        throw new Error(`No download_url for "${relativePath}" of "${skillSlug}"`)
      }
      const res = await fetchWithTimeout(entry.download_url, { headers: { 'User-Agent': 'Halo-Store/1.0' } })
      if (!res.ok) {
        // A partial skill is broken at runtime — fail the install instead.
        throw new Error(`Failed to download "${relativePath}" of "${skillSlug}": HTTP ${res.status}`)
      }
      result[relativePath] = await res.text()

    } else if (entry.type === 'dir') {
      const subFiles = await collectSkillFilesLegacy(owner, repo, entry.path, relativePath, skillSlug, onProgress)
      Object.assign(result, subFiles)
    }
  }))

  return result
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class ClaudeSkillsAdapter implements RegistryAdapter {
  readonly strategy = 'mirror' as const

  async fetchIndex(source: RegistrySource): Promise<RegistryIndex> {
    const baseUrl = source.url.replace(/\/+$/, '')
    const url = `${baseUrl}/featured.json`
    const t0 = performance.now()

    const response = await fetchWithTimeout(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Halo-Store/1.0' },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json() as unknown

    if (!data || typeof data !== 'object' || !('skills' in data) || !Array.isArray((data as FeaturedIndex).skills)) {
      throw new Error('Claude Skills Registry: unexpected featured.json format')
    }

    const skills = (data as FeaturedIndex).skills
    const apps: RegistryEntry[] = []
    const seenSlugs = new Set<string>()

    for (const skill of skills) {
      if (!skill.name || !skill.install) continue

      const slug = sanitizeSlug(skill.name)
      if (!slug || seenSlugs.has(slug)) continue
      seenSlugs.add(slug)

      apps.push({
        slug,
        name: skill.name,
        version: '1.0',
        author: skill.repo ?? 'community',
        description: skill.description ?? skill.name,
        type: 'skill',
        format: 'bundle',
        // Full install path: "owner/repo/path/to/SKILL.md"
        path: skill.install,
        category: skill.category ?? 'other',
        tags: Array.isArray(skill.tags) ? skill.tags : [],
        meta: {
          rank: typeof skill.stars === 'number' ? skill.stars : undefined,
          branch: skill.branch || 'main',
          repo: skill.repo,
        },
      })
    }

    const dt = performance.now() - t0
    console.log(`[ClaudeSkillsAdapter] Loaded ${apps.length} featured skills (${dt.toFixed(0)}ms)`)

    return {
      version: 1,
      generated_at: new Date().toISOString(),
      source: source.url,
      apps,
    }
  }

  async fetchSpec(
    source: RegistrySource,
    entry: RegistryEntry,
    onProgress?: SkillDownloadProgress,
  ): Promise<AppSpec> {
    // entry.path = "owner/repo/path/to/skill-folder/SKILL.md"
    const installPath = entry.path
    if (!installPath) {
      throw new Error(`No install path for skill "${entry.slug}"`)
    }

    // Parse "owner/repo/rest-of-path"
    const parts = installPath.match(/^([^/]+)\/([^/]+)\/(.+)$/)
    if (!parts) {
      throw new Error(`Cannot parse install path for skill "${entry.slug}": "${installPath}"`)
    }
    const [, owner, repo, pathInRepo] = parts

    // If path ends with a file (has extension), strip it to get the directory.
    // e.g. ".claude/skills/fix/SKILL.md" → ".claude/skills/fix"
    // e.g. "skills/scientific/clinical-decision-support" → unchanged
    const dirPath = /\/SKILL\.md$/i.test(pathInRepo)
      ? pathInRepo.replace(/\/SKILL\.md$/i, '')
      : pathInRepo

    // Use branch from registry metadata (falls back to 'main')
    const branch = (entry.meta?.branch as string | undefined) ?? 'main'

    // Collect all skill files — 1 GitHub API call via Git Trees API
    const skill_files = await collectSkillFilesViaTree(owner, repo, dirPath, branch, entry.slug, onProgress)

    if (Object.keys(skill_files).length === 0) {
      throw new Error(`No files found (or all downloads failed) for skill "${entry.slug}": ${dirPath}`)
    }

    console.log(
      `[ClaudeSkillsAdapter] Collected ${Object.keys(skill_files).length} files for "${entry.slug}": ` +
      Object.keys(skill_files).join(', ')
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
        registry_id: source.id,
      },
    }
    return spec
  }

  /**
   * Fetch SKILL.md directly from raw.githubusercontent.com — zero GitHub API
   * quota, unlike fetchSpec which lists the whole tree.
   */
  async fetchDocument(_source: RegistrySource, entry: RegistryEntry): Promise<string | null> {
    const installPath = entry.path
    if (!installPath) return null

    const parts = installPath.match(/^([^/]+)\/([^/]+)\/(.+)$/)
    if (!parts) return null
    const [, owner, repo, pathInRepo] = parts

    const filePath = /\/SKILL\.md$/i.test(pathInRepo) ? pathInRepo : `${pathInRepo}/SKILL.md`
    const branch = (entry.meta?.branch as string | undefined) ?? 'main'
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${filePath}`

    const res = await fetchWithTimeout(rawUrl, { headers: { 'User-Agent': 'Halo-Store/1.0' } })
    if (!res.ok) {
      console.log(`[ClaudeSkillsAdapter] No document for "${entry.slug}" (HTTP ${res.status})`)
      return null
    }
    return await res.text()
  }
}
