/**
 * apps/skill-discovery
 *
 * Enumerates the skills a digital human can actually load at runtime by
 * scanning the exact directories the Claude Code SDK reads (see
 * services/agent/sdk-config.ts: settingSources ['user','project']):
 *
 *   - Global (user):   $CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md
 *   - Space (project): <workDir>/.claude/skills/<name>/SKILL.md
 *
 * where workDir is the digital human's space working directory (the agent cwd).
 *
 * This is deliberately disk-based, not DB-based: global skills and manually
 * placed skills frequently have no installed-apps record, and space skills are
 * bound to a space's working dir — so filtering the app table would show an
 * empty or wrong list. The disk is the runtime source of truth.
 *
 * It also resolves a `requires.skills` entry to the folder it names, so
 * declaring, installing and packaging a dependency all agree on which skill
 * that is; reads a hand-placed folder for packaging; and finds the skills a
 * system prompt names without declaring them.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, type Dirent } from 'fs'
import { join } from 'path'
import { resolveGlobalSkillsDir } from './manager/skill-sync'
import { getWorkingDir } from '../services/agent/helpers'
import { extractFrontmatterField } from '../../shared/skill-frontmatter'
import { toSkillDirName } from '../../shared/skill-naming'
import { isHaloShippedSkill } from '../../shared/apps/app-types'
import type { AvailableSkill } from '../../shared/apps/app-types'
import type { SkillDependency } from '../../shared/apps/spec-types'
import { findReferencedSkillNames } from '../../shared/apps/skill-references'
import { CPP_LEVEL_IGNORE_DIRS } from '../../shared/constants/ignore-patterns'
import type { AppSpec } from './spec'
import type { AppManagerService } from './manager'

/** Cap per-skill content to keep the response light for large skill sets. */
const MAX_CONTENT_CHARS = 20000

function scanSkillsDir(dir: string, scope: 'global' | 'space'): AvailableSkill[] {
  if (!existsSync(dir)) return []

  const results: AvailableSkill[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    console.warn(`[SkillDiscovery] Failed to read ${dir}:`, (err as Error).message)
    return []
  }

  for (const entry of entries) {
    // Symlinked skill dirs load fine in the SDK; the SKILL.md check below
    // filters out symlinks that don't point at a skill directory.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const skillDir = join(dir, entry.name)
    const mdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(mdPath)) continue

    let content = ''
    try {
      content = readFileSync(mdPath, 'utf-8')
    } catch {
      continue
    }

    const name = extractFrontmatterField(content, 'name') || entry.name
    const description = extractFrontmatterField(content, 'description') || ''
    results.push({
      name,
      description,
      scope,
      dirName: entry.name,
      path: skillDir,
      content: content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content,
    })
  }

  return results
}

function skillDirsOf(spaceId: string): { globalDir: string; spaceDir: string } {
  return { globalDir: resolveGlobalSkillsDir(), spaceDir: join(getWorkingDir(spaceId), '.claude', 'skills') }
}

/**
 * List the skills a digital human in the given space can load at runtime.
 * Space skills take precedence over global skills with the same name,
 * matching Halo SDK's project-first, case-insensitive lookup.
 */
export function listAvailableSkills(spaceId: string): AvailableSkill[] {
  const { globalDir, spaceDir } = skillDirsOf(spaceId)

  const globalSkills = scanSkillsDir(globalDir, 'global')
  const spaceSkills = scanSkillsDir(spaceDir, 'space')

  const seen = new Set<string>()
  const merged = [...spaceSkills, ...globalSkills].filter(skill => {
    const key = skill.dirName.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  merged.sort((a, b) => a.name.localeCompare(b.name))

  console.log(
    `[SkillDiscovery] space=${spaceId}: ${spaceSkills.length} space + ` +
    `${globalSkills.length} global → ${merged.length} available`
  )
  return merged
}

/**
 * Every copy of every skill the space's engine may load, a global and a space
 * skill of the same name both kept. Which copy the engine loads for a name is
 * its own order, so a check of what may load has to hold for each.
 */
export function listLoadableSkillCopies(spaceId: string): AvailableSkill[] {
  const { globalDir, spaceDir } = skillDirsOf(spaceId)
  return [...scanSkillsDir(spaceDir, 'space'), ...scanSkillsDir(globalDir, 'global')]
}

type SkillAppSource = Pick<AppManagerService, 'listApps'>
type InstalledSkillApp = ReturnType<AppManagerService['listApps']>[number]

/** A skill folder the engine may load, with the installed skill app behind it when there is one. */
export interface LoadableSkill {
  folder: string
  path: string
  app: InstalledSkillApp | null
}

function skillFolders(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(dir, entry.name, 'SKILL.md')))
      .map(entry => entry.name)
  } catch (err) {
    console.warn(`[SkillDiscovery] Failed to read ${dir}:`, (err as Error).message)
    return []
  }
}

/**
 * The skills that may load in a space (global only when `spaceId` is null),
 * the space folder winning a name both scopes hold (see listAvailableSkills).
 * Folders placed by hand have no installed app and are
 * included all the same; a folder is only matched to an app installed in its
 * own scope.
 */
export function listLoadableSkills(spaceId: string | null, manager: SkillAppSource): LoadableSkill[] {
  // Match the winning folder to its own scope, including hand-placed skills.
  const apps = [
    ...manager.listApps({ spaceId: null, type: 'skill' }),
    ...(spaceId ? manager.listApps({ spaceId, type: 'skill' }) : []),
  ].filter(app => app.status !== 'uninstalled')
  const scopes = [
    ...(spaceId ? [{ dir: skillDirsOf(spaceId).spaceDir, spaceId }] : []),
    { dir: resolveGlobalSkillsDir(), spaceId: null },
  ]
  const skills: LoadableSkill[] = []
  const seen = new Set<string>()
  for (const scope of scopes) {
    for (const folder of skillFolders(scope.dir)) {
      const key = folder.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const app = apps.find(candidate => candidate.spaceId === scope.spaceId && toSkillDirName(candidate.specId) === folder) ?? null
      skills.push({ folder, path: join(scope.dir, folder), app })
    }
  }
  return skills
}

/**
 * The loadable skill a `requires.skills` entry names: the folder name, the
 * installed app's specId or its Store slug, in any case. A namespaced id is
 * matched by its full slug only, so another author's skill of the same name
 * is never taken for the local one.
 */
export function findLoadableSkill(skills: LoadableSkill[], dep: SkillDependency): LoadableSkill | undefined {
  const id = typeof dep === 'string' ? dep : dep.id
  const keys = new Set([id, toSkillDirName(id)].map(key => key.toLowerCase()))
  return skills.find(skill =>
    [skill.folder, skill.app?.specId, skill.app?.spec.store?.slug].some(key => !!key && keys.has(key.toLowerCase())))
}

/**
 * `deps` with each entry naming a Store-installed skill rewritten to its Store
 * slug, so installers fetch it from the Store; entries naming the same skill
 * collapse to the first.
 */
export function normalizeSkillDependencies(deps: readonly SkillDependency[], skills: LoadableSkill[]): SkillDependency[] {
  const seen = new Set<string>()
  const normalized: SkillDependency[] = []
  for (const dep of deps) {
    const skill = findLoadableSkill(skills, dep)
    const store = skill?.app?.spec.store
    const bundled = typeof dep !== 'string' && dep.bundled === true
    const slug = !bundled && store?.install_source === 'store' && store.slug ? store.slug : null
    const id = slug ?? (typeof dep === 'string' ? dep : dep.id)
    const key = skill ? `folder:${skill.folder}` : `id:${id.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(slug === null ? dep : typeof dep === 'string' ? slug : { ...dep, id: slug })
  }
  return normalized
}

/** Packages carry text only; a file past this is not skill content. */
const MAX_PACKAGED_FILE_BYTES = 1024 * 1024
const MAX_PACKAGED_SKILL_BYTES = 50 * 1024 * 1024
const SKIPPED_PACKAGE_DIRS = new Set(CPP_LEVEL_IGNORE_DIRS)

/**
 * Whether a skill folder's SKILL.md would survive packaging: a regular file,
 * text, within the size limit. Reads that one file only.
 */
export function hasPackageableSkillMd(skill: LoadableSkill): boolean {
  try {
    const path = join(skill.path, 'SKILL.md')
    const stat = lstatSync(path)
    return stat.isFile() && stat.size <= MAX_PACKAGED_FILE_BYTES && !readFileSync(path).includes(0)
  } catch {
    return false
  }
}

/**
 * A loadable skill's files for packaging, keyed by forward-slash path. Hidden
 * entries and dependency or cache directories are left out, as are symlinks
 * and binary or oversized files, which a text package cannot carry. Null when
 * part of the folder cannot be read: a partial copy is not the skill.
 */
export function readLoadableSkillFiles(skill: LoadableSkill): Record<string, string> | null {
  const files: Record<string, string> = {}
  let totalBytes = 0
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIPPED_PACKAGE_DIRS.has(entry.name)) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        console.warn(`[SkillDiscovery] Not packaging ${skill.folder}/${path}: symlink`)
      } else if (entry.isDirectory()) {
        walk(join(dir, entry.name), path)
      } else if (entry.isFile()) {
        const filePath = join(dir, entry.name)
        const stat = lstatSync(filePath)
        if (!stat.isFile()) {
          console.warn(`[SkillDiscovery] Not packaging ${skill.folder}/${path}: not a regular file`)
          continue
        }
        if (stat.size > MAX_PACKAGED_FILE_BYTES) {
          console.warn(`[SkillDiscovery] Not packaging ${skill.folder}/${path}: binary or larger than ${MAX_PACKAGED_FILE_BYTES} bytes`)
          continue
        }
        if (stat.size > MAX_PACKAGED_SKILL_BYTES - totalBytes) {
          throw new Error(`${path} exceeds remaining packaging budget (${totalBytes}/${MAX_PACKAGED_SKILL_BYTES} bytes read)`)
        }
        const content = readFileSync(filePath)
        totalBytes += content.length
        if (totalBytes > MAX_PACKAGED_SKILL_BYTES) {
          throw new Error(`${path} exceeds packaging budget (${totalBytes}/${MAX_PACKAGED_SKILL_BYTES} bytes read)`)
        }
        if (content.length > MAX_PACKAGED_FILE_BYTES || content.includes(0)) {
          console.warn(`[SkillDiscovery] Not packaging ${skill.folder}/${path}: binary or larger than ${MAX_PACKAGED_FILE_BYTES} bytes`)
          continue
        }
        files[path] = content.toString('utf8')
      }
    }
  }
  try {
    walk(skill.path, '')
  } catch (err) {
    console.warn(`[SkillDiscovery] Cannot read skill folder ${skill.folder} for packaging:`, (err as Error).message)
    return null
  }
  return files
}

export interface UndeclaredSkill {
  /** The id to declare: the Store slug for a Store install, else the specId or folder name. */
  id: string
  folder: string
}

/**
 * Skills a digital human's system prompt names by folder without declaring
 * them in `requires.skills`, excluding the ones Halo ships. `skills` is what
 * `listLoadableSkills` returns for the digital human's space.
 */
export function findUndeclaredSkills(spec: AppSpec, skills: LoadableSkill[]): UndeclaredSkill[] {
  if (spec.type !== 'automation') return []
  const declared = spec.requires?.skills ?? []
  const candidates = skills.filter(skill =>
    !(skill.app && isHaloShippedSkill(skill.app)) && !declared.some(dep => findLoadableSkill([skill], dep)))
  const named = new Set(findReferencedSkillNames(spec.system_prompt, candidates.map(skill => skill.folder)))
  return candidates
    .filter(skill => named.has(skill.folder))
    .map(skill => {
      const store = skill.app?.spec.store
      const id = store?.install_source === 'store' && store.slug ? store.slug : skill.app?.specId ?? skill.folder
      return { id, folder: skill.folder }
    })
    .sort((a, b) => a.folder.localeCompare(b.folder))
}

