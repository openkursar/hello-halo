import { lstatSync, opendirSync } from 'node:fs'
import { join, resolve, basename, dirname, sep } from 'node:path'
import type { AppManagerService, InstalledApp } from '../manager'
import type { SkillSpec } from '../spec'
import {
  classifySkillSource, skillFilePath, readSkillPackage,
  writeSkillPackage, moveSkillFiles, skillRevision, skillPackageDigest, withoutIncidentalFiles,
} from '../../services/skills'
import { alignSkillMdName, normalizeSkillMd } from '../../../shared/skill-frontmatter'
import { canonicalSkillPath } from '../../services/skills'
import { readSkillPreference, writeSkillPreference } from '../../services/skills'
import { toSkillDirName } from '../../../shared/skill-naming'

export interface SkillMigrationContext {
  manager: AppManagerService
  haloDir: string
  workDir: string | null
  /** The space's own folder, unaffected by a session's working directory; falls back to `workDir`. */
  spaceWorkDir?: string | null
  spaceDataPath: string | null
  legacyGlobalRoots: string[]
  ownedLegacyGlobalRoot?: string
}

function spaceFolder(app: InstalledApp, context: SkillMigrationContext): string | null {
  return app.spaceId === null ? null : context.spaceWorkDir ?? context.workDir
}

function packageOf(spec: SkillSpec) {
  const files = { ...(spec.skill_files ?? (spec.skill_content ? { 'SKILL.md': spec.skill_content } : {})) }
  if (files['SKILL.md']) files['SKILL.md'] = alignSkillMdName(normalizeSkillMd(files['SKILL.md']), spec)
  return { files, assets: spec.skill_assets ?? {} }
}

/** What the files on disk say, read the way `packageOf` reads a stored package. */
function diskPackageOf(spec: SkillSpec, pkg: ReturnType<typeof readSkillPackage>) {
  const { files, assets } = withoutIncidentalFiles(pkg)
  if (files['SKILL.md']) files['SKILL.md'] = alignSkillMdName(normalizeSkillMd(files['SKILL.md']), spec)
  return { files, assets }
}

/** Whether a live installation other than `app` already owns the folder at `filePath`. */
function claimedElsewhere(app: InstalledApp, filePath: string, context: SkillMigrationContext): boolean {
  return context.manager.listSkillRecords(app.spaceId).some(other => {
    const state = other.userOverrides.skill
    return other.id !== app.id && !!state?.filePath && !state.deleted && other.status !== 'uninstalled'
      && resolve(state.filePath) === resolve(filePath)
  })
}

/** The destination already holds exactly this package, and no other installation owns it. */
function destinationHolds(destination: string, stored: ReturnType<typeof packageOf>, app: InstalledApp, context: SkillMigrationContext): boolean {
  const target = readSkillPackage(destination)
  return equalPackage(stored, withoutIncidentalFiles(target)) && !claimedElsewhere(app, destination, context)
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
          ? join(dirname(dirname(skillFilePath(null, entry.name.slice(0, -3)))), entry.name)
          : skillFilePath(null, entry.name)
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

/** Where earlier builds kept store, built-in and digital-human skills before every skill shared one folder. */
function retiredPrivateRoot(app: InstalledApp, context: SkillMigrationContext): string | undefined {
  if (app.spaceId === null) return join(context.haloDir, 'skills')
  return context.spaceDataPath ? join(context.spaceDataPath, '.halo', 'skills') : undefined
}

const relocationFailures = new Set<string>()

/**
 * Moves a skill recorded under a retired private root into the shared skill folder.
 * An occupied destination is left alone: the skill keeps working where it is.
 */
function relocateRetiredSkill(summary: InstalledApp, context: SkillMigrationContext, onMigrated?: () => void): void {
  const state = summary.userOverrides.skill
  const root = retiredPrivateRoot(summary, context)
  if (!state?.filePath || !root || !resolve(state.filePath).startsWith(resolve(root) + sep)) return
  const app = context.manager.getSkillRecord(summary.id)
  if (!app || app.spec.type !== 'skill' || classifySkillSource(app.spec) === 'personal') return
  const spec = app.spec
  let moved: { from: string; to: string; revision: string } | undefined
  try {
    const destination = skillFilePath(spaceFolder(app, context), spec.name)
    if (!fileExists(state.filePath) || fileExists(dirname(destination))) return
    moveSkillFiles(state.filePath, destination, skillRevision(state.filePath))
    moved = { from: state.filePath, to: destination, revision: skillRevision(destination) }
    const disk = readSkillPackage(destination)
    const unchanged = equalPackage(packageOf(spec), diskPackageOf(spec, disk))
    context.manager.updateSkillRecord(app.id, {
      skill: { ...state, filePath: destination, digest: state.digest ?? (unchanged ? skillPackageDigest(disk) : undefined) },
    })
    relocationFailures.delete(app.id)
    onMigrated?.()
  } catch (error) {
    if (moved) {
      try { moveSkillFiles(moved.to, moved.from, moved.revision) }
      catch (rollbackError) { console.error('[Skills] Relocation rollback failed; files retained at the destination', { appId: app.id, rollbackError }) }
    }
    if (!relocationFailures.has(app.id)) {
      relocationFailures.add(app.id)
      console.warn('[Skills] Skill stays in its previous folder; relocation will be retried', { appId: app.id, reason: (error as Error).message })
    }
  }
}

export function migrateSkillRecord(summary: InstalledApp, context: SkillMigrationContext, onMigrated?: () => void): string | undefined {
  const previous = summary.userOverrides.skill
  if (summary.status === 'uninstalled' || previous?.deleted) return
  if (previous?.version === 1 && previous.migrationWarning !== missingLegacyFiles) {
    relocateRetiredSkill(summary, context, onMigrated)
    return
  }
  const app = context.manager.getSkillRecord(summary.id)
  if (!app || app.spec.type !== 'skill') return
  const spec = app.spec
  const source = classifySkillSource(spec)
  let moved: { from: string; to: string; revision: string } | undefined
  try {
  const folder = spaceFolder(app, context)
  const destination = skillFilePath(folder, spec.name)
  const roots = app.spaceId === null ? context.legacyGlobalRoots : folder ? [join(folder, '.claude', 'skills')] : []
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
        const occupied = fileExists(dirname(destination))
        if (occupied && !destinationHolds(destination, stored, app, context)) {
          throw new Error('The destination already contains different skill files. The legacy content was kept for recovery.')
        }
        warning = 'Your existing skill files were preserved separately from the installed version.'
        const identity = canonicalSkillPath(oldPath)
        const preference = readSkillPreference(context.haloDir, identity)
        writeSkillPreference(context.haloDir, identity, { ...preference, enabled: app.status === 'active' && preference.enabled !== false })
        if (!occupied) writeSkillPackage(destination, stored.files, stored.assets)
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
      if (!destinationHolds(destination, stored, app, context)) {
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
    let digest: string | undefined
    if (source !== 'personal') {
      const disk = readSkillPackage(filePath)
      if (equalPackage(stored, withoutIncidentalFiles(disk))) digest = skillPackageDigest(disk)
    }
    context.manager.updateSkillRecord(app.id, {
      spec: nextSpec,
      skill: { ...previous, version: 1, filePath, digest, migrationWarning: undefined },
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
