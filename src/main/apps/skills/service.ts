import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import type { SkillSpec } from '../../../shared/apps/spec-types'
import type {
  SkillRef, SkillCopy, SkillDetail, SkillSaveInput, SkillImportInput, SkillMoveInput,
  SkillMovePreview, SkillCopyInput, SkillListQuery,
} from '../../../shared/types/skills'
import {
  canonicalSkillPath, classifySkillSource, managedSkillPath, personalSkillPath, readSkillPackage,
  writeSkillPackage, writeSkillContent, moveSkillFiles, skillRevision, prepareSkillRemoval,
  parseSkillMetadata, validateSkillName, skillRemovalPath,
} from '../../services/skills'
import { withSkillMdName } from '../../../shared/skill-frontmatter'
import { validateAppSpec } from '../spec'
import { buildSkillCatalog, listSkillInventory, effectiveSkillCatalog, type SkillCandidate, type SkillLibraryContext } from './catalog'
import { readSkillPreference, removeSkillPreference, writeSkillPreference } from '../../services/skills'

export interface SkillLibraryDependencies {
  context: (spaceId: string | null, workDir?: string) => SkillLibraryContext
  trash: (path: string) => Promise<void>
  openFolder: (path: string) => void
}

function checkRef(ref: SkillRef): void {
  if (!ref || typeof ref.id !== 'string' || !/^(file:[a-f0-9]{64}|app:[a-zA-Z0-9-]{1,128})$/.test(ref.id)) throw new Error('Invalid skill reference.')
  if (ref.spaceId !== null && (typeof ref.spaceId !== 'string' || ref.spaceId.length > 128)) throw new Error('Invalid workspace reference.')
}

function checkRevision(revision: string): void {
  if (typeof revision !== 'string' || !revision || revision.length > 512) throw new Error('Read the current skill before changing its files.')
}

function skillRootMissing(filePath: string): boolean {
  if (!filePath) return false
  try { lstatSync(skillRemovalPath(filePath)); return false }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

function personalSpec(spec: SkillSpec): import('../spec').SkillSpec {
  const { store: _store, ...rest } = spec
  return validateAppSpec({ ...rest, store: { install_source: 'manual', tags: [] } }) as import('../spec').SkillSpec
}

export function createSkillLibrary(deps: SkillLibraryDependencies) {
  const pendingImports = new Map<string, Promise<SkillCopy>>()
  const pendingDeletes = new Set<string>()

  function find(ref: SkillRef): { item: SkillCandidate; context: SkillLibraryContext } {
    checkRef(ref)
    const context = deps.context(ref.spaceId)
    const catalog = buildSkillCatalog(context)
    const item = catalog.candidates.find(candidate => candidate.copy.id === ref.id || (ref.id.startsWith('app:') && candidate.app?.id === ref.id.slice(4)))
    if (!item) throw new Error('This skill is no longer available in the selected workspace. Refresh the list.')
    if (pendingDeletes.has(item.copy.id)) throw new Error('This skill is being deleted. Wait for deletion to finish.')
    return { item, context }
  }

  function findPath(spaceId: string | null, path: string): SkillCopy {
    const canonical = canonicalSkillPath(path)
    const catalog = buildSkillCatalog(deps.context(spaceId))
    const item = catalog.candidates.find(candidate => canonicalSkillPath(candidate.filePath) === canonical)
    if (!item) throw new Error('The skill was saved but could not be read back. Refresh the list.')
    return { ...item.copy, revision: skillRevision(item.filePath) }
  }

  function readCandidate(item: SkillCandidate, context: SkillLibraryContext): SkillDetail {
    if (!item.filePath) throw new Error(item.copy.error ?? 'The skill file is unavailable.')
    const stored = item.app ? context.manager.getSkillRecord(item.app.id) : null
    const base = stored?.spec.type === 'skill' ? stored.spec : undefined
    const spec: SkillSpec = {
      ...base, type: 'skill', spec_version: base?.spec_version ?? '1.0', version: base?.version ?? '1.0',
      name: item.copy.name, display_name: item.copy.displayName !== item.copy.name ? item.copy.displayName : undefined,
      description: item.copy.description || `Skill: ${item.copy.displayName}`,
      skill_content: undefined, skill_files: undefined, skill_assets: undefined, skill_modes: undefined,
    }
    if (skillRootMissing(item.filePath)) {
      return { copy: { ...item.copy, availability: 'missing', revision: 'missing', editable: false }, content: '', revision: 'missing', files: [], spec }
    }
    const pack = readSkillPackage(item.filePath)
    return {
      copy: { ...item.copy, revision: pack.revision }, content: pack.files['SKILL.md'] ?? '',
      revision: pack.revision, files: pack.entries,
      spec: { ...spec, skill_files: pack.files, skill_assets: pack.assets, skill_modes: pack.modes },
    }
  }

  function read(ref: SkillRef): SkillDetail {
    const { item, context } = find(ref)
    return readCandidate(item, context)
  }

  function save(input: SkillSaveInput): SkillDetail {
    checkRevision(input.revision)
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > 1024 * 1024) throw new Error('Skill instructions exceed the supported size.')
    const { item, context } = find(input.ref)
    const metadata = parseSkillMetadata(input.content, item.copy.name)
    if (metadata.error) throw new Error(metadata.error)
    const original = readSkillPackage(item.filePath)
    const app = item.app ? context.manager.getApp(item.app.id) : null
    writeSkillContent(item.filePath, input.content, input.revision)
    if (app?.spec.type === 'skill') {
      try {
        const spec = item.copy.source === 'personal'
          ? { ...app.spec, name: metadata.name, description: metadata.description, skill_content: undefined, skill_files: undefined, skill_assets: undefined }
          : { ...app.spec, name: metadata.name, description: metadata.description, skill_content: undefined, skill_files: { ...original.files, 'SKILL.md': input.content }, skill_assets: original.assets }
        context.manager.updateSkillRecord(app.id, { spec, skill: { ...app.userOverrides.skill!, customized: true } })
      } catch (error) {
        try { writeSkillContent(item.filePath, original.files['SKILL.md'], skillRevision(item.filePath)) }
        catch (rollbackError) { console.error('[Skills] Failed to restore instructions after record failure', { id: item.copy.id, rollbackError }) }
        throw error
      }
    }
    item.copy = { ...item.copy, name: metadata.name, description: metadata.description }
    return readCandidate(item, context)
  }

  async function importSkill(input: SkillImportInput): Promise<SkillCopy> {
    if (!input || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)) throw new Error('An import request ID is required.')
    const key = `${input.spaceId ?? 'global'}:${input.requestId}`
    const pending = pendingImports.get(key)
    if (pending) return pending
    const operation = (async () => {
      const parsed = validateAppSpec(input.spec)
      if (parsed.type !== 'skill') throw new Error('Only a skill can be imported here.')
      const spec = personalSpec(parsed)
      validateSkillName(spec.name)
      const context = deps.context(input.spaceId)
      const target = personalSkillPath(context.workDir, spec.name)
      const preference = readSkillPreference(context.haloDir, canonicalSkillPath(target))
      if (existsSync(target) && preference.requestId === input.requestId) return findPath(input.spaceId, target)
      if (input.replace) {
        checkRevision(input.replace.revision)
        const { item } = find(input.replace.ref)
        if (item.copy.source !== 'personal' || item.copy.spaceId !== input.spaceId) throw new Error('Only your own skill in the selected scope can be replaced.')
        if (item.copy.name.toLowerCase() !== spec.name.toLowerCase()) throw new Error('Use Save as a new skill to change the imported skill name.')
        const canonical = canonicalSkillPath(item.filePath)
        const before = readSkillPreference(context.haloDir, canonical)
        if (before.requestId === input.requestId) return findPath(input.spaceId, item.filePath)
        const files = spec.skill_files ?? (spec.skill_content ? { 'SKILL.md': spec.skill_content } : {})
        const original = readSkillPackage(item.filePath)
        const originalRecord = item.app ? context.manager.getApp(item.app.id) : null
        let writtenRevision: string | undefined
        try {
          writeSkillPackage(item.filePath, files, spec.skill_assets, input.replace.revision, spec.skill_modes)
          writtenRevision = skillRevision(item.filePath)
          writeSkillPreference(context.haloDir, canonical, { ...before, requestId: input.requestId, displayName: spec.display_name })
          if (item.app) context.manager.updateSkillRecord(item.app.id, { spec: { ...spec, skill_content: undefined, skill_files: undefined, skill_assets: undefined } })
        } catch (error) {
          if (writtenRevision) {
            try {
              writeSkillPackage(item.filePath, original.files, original.assets, writtenRevision, original.modes)
              writeSkillPreference(context.haloDir, canonical, before)
              if (originalRecord?.spec.type === 'skill') context.manager.updateSkillRecord(originalRecord.id, { spec: originalRecord.spec })
            } catch (rollbackError) { console.error('[Skills] Replacement rollback failed; inspect both versions before retrying', { id: item.copy.id, rollbackError }) }
          }
          throw error
        }
        return findPath(input.spaceId, item.filePath)
      }
      if (existsSync(target)) throw new Error('A skill already exists here. Read it and explicitly replace it, or choose a different name.')
      const appId = await context.manager.install(input.spaceId, spec)
      const app = context.manager.getApp(appId)
      const filePath = app?.userOverrides.skill?.filePath
      if (!filePath) throw new Error('The installed skill has no file location.')
      writeSkillPreference(context.haloDir, canonicalSkillPath(filePath), { version: 1, requestId: input.requestId, displayName: spec.display_name })
      return findPath(input.spaceId, filePath)
    })()
    pendingImports.set(key, operation)
    try { return await operation } finally { pendingImports.delete(key) }
  }

  function setEnabled(input: { ref: SkillRef; enabled: boolean }): SkillCopy {
    if (typeof input.enabled !== 'boolean') throw new Error('Invalid skill availability setting.')
    const { item, context } = find(input.ref)
    const missing = skillRootMissing(item.filePath)
    if (input.enabled && missing) throw new Error('The skill file is missing. Restore it before enabling this skill.')
    if (!missing) skillRevision(item.filePath)
    if (item.app) {
      if (input.enabled && item.app.status !== 'active') context.manager.resume(item.app.id)
      if (!input.enabled && item.app.status !== 'paused') context.manager.pause(item.app.id)
    }
    if (item.copy.source === 'personal' && !item.app) {
      const path = canonicalSkillPath(item.filePath)
      writeSkillPreference(context.haloDir, path, { ...readSkillPreference(context.haloDir, path), enabled: input.enabled })
    }
    return { ...item.copy, enabled: input.enabled, availability: missing ? 'missing' : input.enabled ? 'available' : 'disabled' }
  }

  function previewMoveFor(item: SkillCandidate, spaceId: string | null): SkillMovePreview {
    const target = deps.context(spaceId)
    const toPath = item.copy.source === 'personal'
      ? personalSkillPath(target.workDir, item.copy.name)
      : managedSkillPath(target.haloDir, target.spaceDataPath, item.app!.id)
    const existing = buildSkillCatalog(target).candidates.find(candidate => candidate.copy.spaceId === spaceId && candidate.copy.name.toLowerCase() === item.copy.name.toLowerCase() && candidate.copy.id !== item.copy.id)
    return {
      fromPath: item.filePath, toPath, fromSpaceId: item.copy.spaceId, toSpaceId: spaceId,
      ...(existing || (existsSync(toPath) && canonicalSkillPath(toPath) !== canonicalSkillPath(item.filePath)) ? { conflict: 'The destination already contains a skill with this name.' } : {}),
    }
  }

  function movePreview(input: { ref: SkillRef; spaceId: string | null }): SkillMovePreview {
    return previewMoveFor(find(input.ref).item, input.spaceId)
  }

  function move(input: SkillMoveInput): SkillCopy {
    checkRevision(input.revision)
    const { item, context } = find(input.ref)
    const preview = previewMoveFor(item, input.spaceId)
    if (preview.conflict) throw new Error(preview.conflict)
    if (item.copy.spaceId === input.spaceId) return { ...item.copy, revision: skillRevision(item.filePath) }
    const sourceIdentity = canonicalSkillPath(item.filePath)
    const targetIdentity = canonicalSkillPath(preview.toPath)
    const preference = readSkillPreference(context.haloDir, sourceIdentity)
    const previousTarget = readSkillPreference(context.haloDir, targetIdentity)
    let moved = false
    try {
      if (item.copy.source === 'personal') writeSkillPreference(context.haloDir, targetIdentity, { ...preference, enabled: item.copy.enabled })
      moveSkillFiles(item.filePath, preview.toPath, input.revision)
      moved = true
      if (item.app) context.manager.updateSkillRecord(item.app.id, { spaceId: input.spaceId, skill: { ...item.app.userOverrides.skill!, filePath: preview.toPath } })
    } catch (error) {
      if (moved) {
        try { moveSkillFiles(preview.toPath, item.filePath, skillRevision(preview.toPath)) }
        catch (rollbackError) { console.error('[Skills] Move rollback failed; files retained at destination', { id: item.copy.id, rollbackError }) }
      }
      if (item.copy.source === 'personal' && !existsSync(preview.toPath)) writeSkillPreference(context.haloDir, targetIdentity, previousTarget)
      throw error
    }
    if (item.copy.source === 'personal' && sourceIdentity !== targetIdentity) {
      try { removeSkillPreference(context.haloDir, sourceIdentity) }
      catch (error) { console.warn('[Skills] Old skill preference retained after a successful move', { id: item.copy.id, reason: (error as Error).message }) }
    }
    return findPath(input.spaceId, preview.toPath)
  }

  async function copy(input: SkillCopyInput): Promise<SkillCopy> {
    validateSkillName(input.name)
    const detail = read(input.ref)
    let spec = personalSpec(withSkillMdName({ ...detail.spec, name: input.name, display_name: undefined }, input.name))
    if (input.content !== undefined) spec = withSkillMdName({ ...spec, skill_files: { ...spec.skill_files, 'SKILL.md': input.content } }, input.name)
    return importSkill({ spaceId: input.spaceId, spec, requestId: randomUUID() })
  }

  async function remove(input: { ref: SkillRef; revision: string }): Promise<void> {
    checkRevision(input.revision)
    const { item, context } = find(input.ref)
    const missing = skillRootMissing(item.filePath)
    if (!missing && skillRevision(item.filePath) !== input.revision) throw new Error('This skill changed since you opened it. Read it again before deleting.')
    const canonical = canonicalSkillPath(item.filePath)
    pendingDeletes.add(item.copy.id)
    try {
      if (item.app) await context.manager.uninstall(item.app.id)
      else if (!missing) await deps.trash(prepareSkillRemoval(item.filePath, input.revision))
      if (item.copy.source === 'personal') removeSkillPreference(context.haloDir, canonical)
    } finally { pendingDeletes.delete(item.copy.id) }
  }

  async function restoreLegacy(input: { appId: string; spaceId: string | null; name?: string }): Promise<SkillCopy> {
    const context = deps.context(input.spaceId)
    const app = context.manager.getApp(input.appId)
    if (!app || app.spec.type !== 'skill' || app.status !== 'uninstalled' || app.userOverrides.skill?.deleted) throw new Error('This legacy skill is no longer available for recovery.')
    const spec = input.name ? withSkillMdName({ ...app.spec, name: input.name }, input.name) : app.spec
    const result = await importSkill({ spaceId: input.spaceId, spec: personalSpec(spec), requestId: randomUUID() })
    if (app.id !== result.appId) context.manager.updateSkillRecord(app.id, { skill: { version: 1, filePath: '', deleted: true } })
    return result
  }

  async function deleteLegacy(input: { appId: string }): Promise<void> {
    const context = deps.context(null)
    const app = context.manager.getApp(input.appId)
    if (!app || app.spec.type !== 'skill' || app.status !== 'uninstalled' || app.userOverrides.skill?.deleted) throw new Error('This legacy skill is no longer available.')
    context.manager.updateSkillRecord(app.id, { skill: { version: 1, filePath: '', deleted: true }, spec: { ...app.spec, skill_content: undefined, skill_files: undefined, skill_assets: undefined } })
  }

  return {
    list(query: SkillListQuery) { return listSkillInventory(deps.context(query.spaceId), query) },
    read, save, import: importSkill, setEnabled, movePreview, move, copy, delete: remove, restoreLegacy, deleteLegacy,
    effectiveCatalog(spaceId: string, workDir?: string) { return effectiveSkillCatalog(deps.context(spaceId, workDir)) },
    runtimeCopies(spaceId: string, workDir?: string) { return buildSkillCatalog(deps.context(spaceId, workDir)).candidates.map(item => item.copy) },
    openFolder(ref: SkillRef) { const { item } = find(ref); deps.openFolder(dirname(item.filePath)) },
    export(ref: SkillRef) {
      const detail = read(ref)
      const entries = Object.fromEntries(Object.entries(detail.spec.skill_files ?? {}).map(([path, text]) => [path, strToU8(text)]))
      for (const [path, asset] of Object.entries(detail.spec.skill_assets ?? {})) entries[path] = Buffer.from(asset.content, 'base64')
      return { filename: `${basename(detail.copy.name)}.zip`, base64: Buffer.from(zipSync(entries)).toString('base64') }
    },
  }
}
