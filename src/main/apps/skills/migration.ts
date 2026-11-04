import { lstatSync, opendirSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import type { AppManagerService, InstalledApp } from '../manager'
import type { SkillSpec } from '../spec'
import {
  classifySkillSource, managedSkillPath, personalSkillPath, readSkillPackage,
  writeSkillPackage, moveSkillFiles, skillRevision,
} from '../../services/skills'
import { alignSkillMdName, normalizeSkillMd } from '../../../shared/skill-frontmatter'
import { canonicalSkillPath } from '../../services/skills'
import { readSkillPreference, writeSkillPreference } from '../../services/skills'
import { toSkillDirName } from '../../../shared/skill-naming'

export interface SkillMigrationContext {
  manager: AppManagerService
  haloDir: string
  workDir: string | null
  spaceDataPath: string | null
  legacyGlobalRoots: string[]
  ownedLegacyGlobalRoot?: string
}

function packageOf(spec: SkillSpec) {
  const files = { ...(spec.skill_files ?? (spec.skill_content ? { 'SKILL.md': spec.skill_content } : {})) }
  if (files['SKILL.md']) files['SKILL.md'] = alignSkillMdName(normalizeSkillMd(files['SKILL.md']), spec)
  return { files, assets: spec.skill_assets ?? {} }
}

function equalPackage(a: ReturnType<typeof packageOf>, b: ReturnType<typeof packageOf>): boolean {
  const stable = (value: Record<string, unknown>) => JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]))
  return stable(a.files) === stable(b.files) && stable(a.assets) === stable(b.assets)
}

function fileExists(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

export function migrateUnregisteredGlobalSkills(records: InstalledApp[], context: SkillMigrationContext): string[] {
  const root = context.ownedLegacyGlobalRoot
  if (!root) return []
  const marker = `migration:personal-root:${resolve(root)}`
  try {
    if (readSkillPreference(context.haloDir, marker).enabled === true) return []
  } catch {
    return ['The previous global skill migration status cannot be read.']
  }
  const registered = new Set(records.filter(app => app.spaceId === null).map(app => toSkillDirName(app.specId)))
  const warnings: string[] = []
  let deferred = false
  let directory: ReturnType<typeof opendirSync>
  try { directory = opendirSync(root) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    console.warn('[Skills] Legacy global directory migration deferred', { reason: (error as Error).message })
    return ['The previous global skill directory cannot be read.']
  }
  try {
    let entry: ReturnType<typeof directory.readSync>
    let count = 0
    while ((entry = directory.readSync()) !== null) {
      if (++count > 2000) {
        deferred = true
        console.warn('[Skills] Legacy global directory migration deferred at the entry limit', { limit: 2000 })
        warnings.push('The previous skill directory is too large to migrate in one pass.')
        break
      }
      if (registered.has(entry.name)) continue
      const flat = entry.name.endsWith('.md') && entry.name !== 'SKILL.md' && !entry.isDirectory()
      const source = flat ? join(root, entry.name) : join(root, entry.name, 'SKILL.md')
      try {
        const preserved = `migration:preserved:${resolve(source)}`
        if (readSkillPreference(context.haloDir, preserved).enabled === true || !fileExists(source)) continue
        const target = flat
          ? join(dirname(dirname(personalSkillPath(null, entry.name.slice(0, -3)))), entry.name)
          : personalSkillPath(null, entry.name)
        if (fileExists(target)) {
          readSkillPackage(source)
          readSkillPackage(target)
          writeSkillPreference(context.haloDir, preserved, { version: 1, enabled: true })
          console.info('[Skills] Preserved unregistered legacy skill at its original location', { name: basename(entry.name), reason: 'destination exists' })
          warnings.push(`Existing files were kept at ${source}; the destination already exists.`)
          continue
        }
        moveSkillFiles(source, target, skillRevision(source))
      } catch (error) {
        deferred = true
        console.warn('[Skills] Unregistered legacy skill was left at its original location', { name: basename(entry.name), reason: (error as Error).message })
        warnings.push(`Could not move ${entry.name}: ${(error as Error).message}`)
      }
    }
  } catch (error) {
    deferred = true
    console.warn('[Skills] Legacy global directory scan could not finish', { reason: (error as Error).message })
    warnings.push('The previous global skill directory could not be fully read.')
  } finally { directory.closeSync() }
  if (!deferred) {
    try { writeSkillPreference(context.haloDir, marker, { version: 1, enabled: true }) }
    catch (error) {
      console.warn('[Skills] Legacy global migration completion could not be saved', { reason: (error as Error).message })
      warnings.push('The previous global skill migration status could not be saved.')
    }
  }
  return warnings
}

const missingLegacyFiles = 'The previous skill files are missing. Restore them before using this skill.'

export function migrateSkillRecord(summary: InstalledApp, context: SkillMigrationContext, onMigrated?: () => void): string | undefined {
  const previous = summary.userOverrides.skill
  if (summary.status === 'uninstalled' || previous?.deleted) return
  if (previous?.version === 1 && previous.migrationWarning !== missingLegacyFiles) return
  const app = context.manager.getSkillRecord(summary.id)
  if (!app || app.spec.type !== 'skill') return
  const spec = app.spec
  const source = classifySkillSource(spec)
  let moved: { from: string; to: string; revision: string } | undefined
  try {
  const destination = source === 'personal'
    ? personalSkillPath(app.spaceId === null ? null : context.workDir, toSkillDirName(spec.name))
    : managedSkillPath(context.haloDir, app.spaceId === null ? null : context.spaceDataPath, app.id)
  const roots = app.spaceId === null ? context.legacyGlobalRoots : context.workDir ? [join(context.workDir, '.claude', 'skills')] : []
  const candidates = roots.map(root => join(root, toSkillDirName(app.specId), 'SKILL.md'))
  const oldPath = candidates.find(path => fileExists(path))
  const stored = packageOf(spec)
  let filePath = destination
  let warning: string | undefined
  if (app.status === 'paused' && source === 'personal') {
    for (const path of [oldPath, !fileExists(destination) ? destination : undefined]) {
      if (!path) continue
      const identity = canonicalSkillPath(path)
      writeSkillPreference(context.haloDir, identity, { ...readSkillPreference(context.haloDir, identity), enabled: false })
    }
  }
    if (oldPath) {
      const disk = readSkillPackage(oldPath)
      const same = equalPackage(stored, { files: disk.files, assets: disk.assets })
      const linked = lstatSync(resolve(oldPath, '..')).isSymbolicLink()
      if (source === 'personal' && (!same || linked)) {
        filePath = oldPath
        warning = 'Existing skill files were kept at their original location.'
      } else if (!same || linked) {
        warning = 'Your existing skill files were preserved separately from the installed version.'
        const identity = canonicalSkillPath(oldPath)
        const preference = readSkillPreference(context.haloDir, identity)
        writeSkillPreference(context.haloDir, identity, { ...preference, enabled: app.status === 'active' && preference.enabled !== false })
        if (!fileExists(destination)) writeSkillPackage(destination, stored.files, stored.assets)
      } else if (resolve(oldPath) !== resolve(destination)) {
        if (fileExists(destination)) {
          const target = readSkillPackage(destination)
          filePath = oldPath
          warning = equalPackage({ files: disk.files, assets: disk.assets }, { files: target.files, assets: target.assets })
            ? 'Both existing locations were preserved. Review the duplicate before moving this skill.'
            : 'The destination contains different skill files. Both existing locations were preserved.'
        } else {
          moveSkillFiles(oldPath, destination, disk.revision)
          moved = { from: oldPath, to: destination, revision: skillRevision(destination) }
        }
      }
    } else if (fileExists(destination)) {
      const target = readSkillPackage(destination)
      if (!equalPackage(stored, { files: target.files, assets: target.assets })) {
        throw new Error('The destination already contains different skill files. The legacy content was kept for recovery.')
      }
    } else {
      if (!stored.files['SKILL.md']) throw new Error('The legacy installation has no recoverable skill instructions.')
      // Before file authority, the generated directory was only a projection of this package.
      writeSkillPackage(destination, stored.files, stored.assets, undefined, spec.skill_modes)
    }
    skillRevision(filePath)
    const nextSpec: SkillSpec = source === 'personal'
      ? { ...spec, skill_content: undefined, skill_files: undefined, skill_assets: undefined }
      : spec
    context.manager.updateSkillRecord(app.id, {
      spec: nextSpec,
      skill: { ...previous, version: 1, filePath, migrationWarning: undefined },
    })
    onMigrated?.()
    if (warning) console.info('[Skills] Preserved legacy skill files during migration', { appId: app.id, reason: warning })
    return undefined
  } catch (error) {
    if (moved) {
      try { moveSkillFiles(moved.to, moved.from, moved.revision) }
      catch (rollbackError) { console.error('[Skills] Legacy migration rollback failed; files retained at the destination', { appId: app.id, rollbackError }) }
    }
    console.warn('[Skills] Legacy skill migration deferred; original data retained', { appId: app.id, reason: (error as Error).message })
    return `Could not migrate ${spec.display_name ?? spec.name}: ${(error as Error).message}`
  }
}
