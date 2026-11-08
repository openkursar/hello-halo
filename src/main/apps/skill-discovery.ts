/**
 * apps/skill-discovery
 *
 * The skills a digital human can load, as the skill library resolves them, and
 * the helpers that tie a `requires.skills` entry to those skills: finding the
 * skill it names, reading a hand-placed folder for packaging, and finding the
 * skills a system prompt names without declaring them.
 */

import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getSkillLibrary } from './skills'
import { skillDirectoryName } from '../services/skills'
import { toSkillDirName } from '../../shared/skill-naming'
import { isHaloShippedSkill } from '../../shared/apps/app-types'
import type { AvailableSkill } from '../../shared/apps/app-types'
import type { SkillDependency } from '../../shared/apps/spec-types'
import { findReferencedSkillNames } from '../../shared/apps/skill-references'
import { CPP_LEVEL_IGNORE_DIRS } from '../../shared/constants/ignore-patterns'
import type { AppSpec } from './spec'
import type { AppManagerService, InstalledApp } from './manager'

function readInstructions(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('The skill instructions cannot be read safely.')
    const buffer = Buffer.alloc(Math.min(info.size, 20000))
    const count = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, count)
  } finally { closeSync(fd) }
}

function availableCopies(spaceId: string, effectiveOnly: boolean, workDir?: string): AvailableSkill[] {
  const library = getSkillLibrary()
  const results: AvailableSkill[] = []
  for (const copy of library.runtimeCopies(spaceId, workDir)) {
    if (!copy.enabled || copy.availability === 'missing' || copy.availability === 'invalid' || (effectiveOnly && copy.availability !== 'available')) continue
    try {
      results.push({ name: copy.name, description: copy.description, scope: copy.scope,
        dirName: copy.name, path: dirname(copy.path), content: readInstructions(copy.path) })
    } catch (error) {
      console.warn('[Skills] Available skill could not be inspected', { id: copy.id, reason: (error as Error).message })
    }
  }
  return results
}

export function listAvailableSkills(spaceId: string): AvailableSkill[] {
  return availableCopies(spaceId, true)
}

/** Permission checks conservatively consider every enabled copy an external engine could discover. */
export function listLoadableSkillCopies(spaceId: string, workDir?: string): AvailableSkill[] {
  return availableCopies(spaceId, false, workDir)
}

type SkillRecordSource = Pick<AppManagerService, 'listSkillRecords'>

/** A skill folder the engine loads, with the installed skill record behind it when there is one. */
export interface LoadableSkill {
  folder: string
  path: string
  app: InstalledApp | null
}

/**
 * The skill folders that load in a space (global only when `spaceId` is null),
 * as the skill library resolves a name both scopes hold. A folder placed by
 * hand has no installed record and is included all the same. Single-file
 * command skills have no folder to name or package and are left out.
 */
export function listLoadableSkills(spaceId: string | null, manager: SkillRecordSource): LoadableSkill[] {
  const records = new Map<string, InstalledApp>()
  for (const scope of spaceId ? [null, spaceId] : [null]) {
    for (const record of manager.listSkillRecords(scope)) records.set(record.id, record)
  }
  return getSkillLibrary().runtimeCopies(spaceId)
    .filter(copy => copy.availability === 'available' && basename(copy.path) === 'SKILL.md')
    .map(copy => ({
      folder: skillDirectoryName(copy.path),
      path: dirname(copy.path),
      app: copy.appId ? records.get(copy.appId) ?? null : null,
    }))
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
  /** The id to declare: the Store slug for a Store install, else the folder name. */
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
      const id = store?.install_source === 'store' && store.slug ? store.slug : skill.folder
      return { id, folder: skill.folder }
    })
    .sort((a, b) => a.folder.localeCompare(b.folder))
}
