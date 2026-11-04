import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { AppManagerService, InstalledApp } from '../manager'
import type { SkillSpec } from '../../../shared/apps/spec-types'
import type { SkillCopy, SkillGroup, SkillInventory, SkillListQuery, SkillCatalogEntry } from '../../../shared/types/skills'
import {
  canonicalSkillPath, classifySkillSource, discoverPersonalSkills, inspectSkill,
  readSkillMetadata, skillFileId, skillSearchRoots,
} from '../../services/skills'
import { readSkillPreference } from '../../services/skills'
import { migrateSkillRecord, migrateUnregisteredGlobalSkills, type SkillMigrationContext } from './migration'

export interface SkillLibraryContext extends SkillMigrationContext {
  spaceId: string | null
  manager: AppManagerService
}

export interface SkillCandidate {
  copy: SkillCopy
  filePath: string
  app?: InstalledApp
}

export interface SkillCatalog {
  candidates: SkillCandidate[]
  groups: SkillGroup[]
  warnings: string[]
  truncated: boolean
  legacyRemoved: SkillInventory['legacyRemoved']
}

function sourceGroup(copies: SkillCopy[]): SkillGroup['source'] {
  if (copies.some(copy => copy.source === 'personal' || copy.source === 'store')) return 'mine'
  return copies.some(copy => copy.source === 'digital-human') ? 'digital-human' : 'builtin'
}

export function resolveSkillGroups(copies: SkillCopy[]): SkillGroup[] {
  const names = new Map<string, SkillCopy[]>()
  for (const copy of copies) {
    const key = copy.name.toLocaleLowerCase('en-US')
    const list = names.get(key) ?? []
    list.push(copy)
    names.set(key, list)
  }
  return Array.from(names, ([name, entries]) => {
    const rank = (copy: SkillCopy) => (copy.scope === 'space' ? 2 : 0) + (copy.source === 'personal' ? 1 : 0)
    entries.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))
    const available = entries.filter(copy => copy.enabled && copy.availability === 'available')
    const top = available.filter(copy => rank(copy) === rank(available[0]))
    const conflict = top.length > 1
    for (const entry of available) entry.availability = top.includes(entry) ? conflict ? 'conflict' : 'available' : 'overridden'
    const chosen = !conflict ? top[0] : undefined
    const display = chosen ?? entries[0]
    return {
      name, displayName: display.displayName, description: display.description,
      source: sourceGroup(entries), copies: entries, effectiveId: chosen?.id, conflict,
    }
  }).sort((a, b) => a.displayName.localeCompare(b.displayName))
}

function recordsFor(context: SkillLibraryContext): InstalledApp[] {
  return [
    ...context.manager.listSkillRecords(null),
    ...(context.spaceId ? context.manager.listSkillRecords(context.spaceId) : []),
  ]
}

export function buildSkillCatalog(context: SkillLibraryContext): SkillCatalog {
  const warnings: string[] = []
  let records = recordsFor(context)
  let migrated = false
  for (const record of records) {
    const warning = migrateSkillRecord(record, context, () => { migrated = true })
    if (warning) warnings.push(warning)
  }
  if (migrated) records = recordsFor(context)
  warnings.push(...migrateUnregisteredGlobalSkills(records, context))
  const discovered = discoverPersonalSkills(context.workDir, context.legacyGlobalRoots)
  warnings.push(...discovered.warnings)
  const candidates: SkillCandidate[] = []
  const usedPaths = new Set<string>()
  const personalRecords = new Map<string, InstalledApp>()
  const permittedRoots = skillSearchRoots(context.workDir).map(root => resolve(root.path) + sep)
  for (const app of records) {
    if (app.spec.type !== 'skill' || app.status === 'uninstalled' || classifySkillSource(app.spec) !== 'personal') continue
    const filePath = app.userOverrides.skill?.filePath
    if (!filePath) continue
    const inCurrentProject = app.spaceId === null || permittedRoots.some(root => resolve(filePath).startsWith(root))
    if (inCurrentProject) {
      try { personalRecords.set(canonicalSkillPath(filePath), app) }
      catch (error) {
        console.warn('[Skills] Recorded personal skill cannot be resolved', { appId: app.id, reason: (error as Error).message })
        warnings.push(`The recorded skill ${app.spec.name} cannot be read.`)
      }
    }
  }
  const personal = [...discovered.skills]
  const discoveredPaths = new Set(personal.map(item => item.canonicalPath))
  for (const [path, app] of personalRecords) {
    if (discoveredPaths.has(path)) continue
    const filePath = app.userOverrides.skill!.filePath
    try { personal.push(inspectSkill(filePath, app.spaceId ? 'space' : 'global')) }
    catch (error) {
      personal.push({ id: skillFileId(filePath), canonicalPath: path, filePath, scope: app.spaceId ? 'space' : 'global', isLink: false,
        name: app.spec.name, description: app.spec.description, error: existsSync(filePath) ? 'The skill file cannot be read.' : 'The skill file is missing.' })
    }
  }
  const managedPaths = new Set<string>()
  for (const app of records) {
    if (app.spec.type !== 'skill' || classifySkillSource(app.spec) === 'personal' || !app.userOverrides.skill?.filePath) continue
    try { managedPaths.add(canonicalSkillPath(app.userOverrides.skill.filePath)) }
    catch (error) {
      console.warn('[Skills] Recorded managed skill cannot be resolved', { appId: app.id, reason: (error as Error).message })
      warnings.push(`The recorded skill ${app.spec.name} cannot be read.`)
    }
  }
  for (const item of personal) {
    if (usedPaths.has(item.canonicalPath) || managedPaths.has(item.canonicalPath)) continue
    usedPaths.add(item.canonicalPath)
    const app = personalRecords.get(item.canonicalPath)
    let enabled = app?.status !== 'paused'
    let displayName = app?.spec.display_name ?? item.name
    let preferenceError: string | undefined
    try {
      const preference = readSkillPreference(context.haloDir, item.canonicalPath)
      enabled = preference.enabled ?? (app ? app.status === 'active' : true)
      displayName = preference.displayName ?? displayName
    } catch { preferenceError = 'The saved skill settings cannot be read.' }
    const copy: SkillCopy = {
      id: item.id, appId: app?.id, name: item.name, displayName, description: item.description,
      author: app?.spec.author, version: app?.spec.version, icon: app?.spec.icon, i18n: app?.spec.i18n,
      path: item.filePath, scope: item.scope, spaceId: item.scope === 'global' ? null : context.spaceId,
      source: 'personal', owners: [], enabled,
      availability: item.error || preferenceError ? existsSync(item.filePath) ? 'invalid' : 'missing' : enabled ? 'available' : 'disabled',
      error: item.error ?? preferenceError, revision: '', editable: existsSync(item.filePath) && !preferenceError, isLink: item.isLink,
    }
    candidates.push({ copy, filePath: item.filePath, app })
  }
  for (const app of records) {
    if (app.spec.type !== 'skill' || app.status === 'uninstalled') continue
    const source = classifySkillSource(app.spec)
    if (source === 'personal') continue
    const state = app.userOverrides.skill
    const filePath = state?.filePath ?? ''
    let error: string | undefined
    let name = app.spec.name
    let description = app.spec.description
    try {
      if (!filePath) throw new Error('This legacy skill could not be migrated.')
      const item = readSkillMetadata(filePath)
      error = item.error
      name = item.name
      description = item.description
    } catch (failure) { error = (failure as Error).message }
    const enabled = app.status === 'active'
    candidates.push({
      filePath, app,
      copy: {
        id: `app:${app.id}`, appId: app.id, name, description, displayName: app.spec.display_name ?? name,
        author: app.spec.author, version: app.spec.version, icon: app.spec.icon, i18n: app.spec.i18n,
        path: filePath, scope: app.spaceId ? 'space' : 'global', spaceId: app.spaceId,
        source, owners: state?.owners ?? [], enabled,
        availability: error ? filePath && existsSync(filePath) ? 'invalid' : 'missing' : enabled ? 'available' : 'disabled',
        error, revision: '', editable: !!filePath && existsSync(filePath), isLink: false,
      },
    })
  }
  return {
    candidates, groups: resolveSkillGroups(candidates.map(item => item.copy)), warnings,
    truncated: discovered.truncated,
    legacyRemoved: records.filter(app => app.status === 'uninstalled' && !app.userOverrides.skill?.deleted)
      .map(app => ({ appId: app.id, name: app.spec.display_name ?? app.spec.name, description: app.spec.description, spaceId: app.spaceId })),
  }
}

export function listSkillInventory(context: SkillLibraryContext, query: SkillListQuery): SkillInventory {
  const catalog = buildSkillCatalog(context)
  const offset = Math.max(0, Math.floor(query.offset ?? 0))
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 50)))
  if (!Number.isFinite(offset) || !Number.isFinite(limit)) throw new Error('Invalid skill list pagination.')
  const q = (query.q ?? '').trim().toLocaleLowerCase()
  const groups = catalog.groups.filter(group =>
    (!query.source || query.source === 'all' || group.source === query.source) &&
    (!q || group.copies.some(copy => `${copy.name} ${copy.displayName} ${copy.description}`.toLocaleLowerCase().includes(q))),
  )
  return {
    groups: groups.slice(offset, offset + limit), offset, limit, total: groups.length,
    truncated: catalog.truncated || groups.length > offset + limit,
    warnings: catalog.warnings, legacyRemoved: catalog.legacyRemoved,
  }
}

export function effectiveSkillCatalog(context: SkillLibraryContext): SkillCatalogEntry[] {
  const catalog = buildSkillCatalog(context)
  const effective = new Set(catalog.groups.flatMap(group => group.effectiveId ? [group.effectiveId] : []))
  return catalog.candidates.filter(item => effective.has(item.copy.id)).map(item => {
    const metadata = readSkillMetadata(item.filePath)
    return { name: item.copy.name, description: item.copy.description, argumentHint: metadata.argumentHint, whenToUse: metadata.whenToUse, source: { kind: 'file', path: item.filePath } }
  })
}
