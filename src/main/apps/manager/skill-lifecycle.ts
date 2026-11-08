import { createHash } from 'crypto'
import { lstatSync, rmSync } from 'fs'
import { resolve } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { shell } from 'electron'
import type { SkillSpec } from '../spec'
import { validateAppSpec } from '../spec'
import type { InstalledApp, AppStatus } from './types'
import type { AppManagerDeps } from './service'
import type { SkillInstallationState } from '../../../shared/types/skills'
import { setSkillMdName } from '../../../shared/skill-frontmatter'
import {
  classifySkillSource, skillFilePath, parseSkillMetadata, skillSourceIdentity, sameSkillSource,
  canonicalSkillPath, readSkillPreference, writeSkillPreference,
  readSkillPackage, writeSkillPackage, writeSkillContent, moveSkillFiles, skillRevision, skillPackageDigest, withoutIncidentalFiles, skillRemovalPath, prepareSkillRemoval,
} from '../../services/skills'
import { AppAlreadyInstalledError, SpaceNotFoundError } from './errors'

export function skillPackage(spec: SkillSpec): {
  files: Record<string, string>
  assets: NonNullable<SkillSpec['skill_assets']>
} {
  const files = { ...(spec.skill_files ?? {}) }
  if (spec.skill_content !== undefined && files['SKILL.md'] === undefined) files['SKILL.md'] = spec.skill_content
  const content = files['SKILL.md']
  if (content === undefined) throw new Error('The skill package must contain SKILL.md')
  if (Object.keys(spec.skill_assets ?? {}).some(path => Object.hasOwn(files, path))) throw new Error('Duplicate skill package path')
  files['SKILL.md'] = /^---[ \t]*\r?\n/.test(content)
    ? setSkillMdName(content, spec.name)
    : `---\nname: ${JSON.stringify(spec.name)}\ndescription: ${JSON.stringify(spec.description)}\n---\n\n${content}`
  const metadata = parseSkillMetadata(files['SKILL.md'], spec.name)
  if (metadata.error) throw new Error(metadata.error)
  return { files, assets: spec.skill_assets ?? {} }
}

export function storedSkillSpec(spec: SkillSpec): SkillSpec {
  if (classifySkillSource(spec) !== 'personal') return spec
  const { skill_content: _content, skill_files: _files, skill_assets: _assets, skill_modes: _modes, ...metadata } = spec
  return metadata
}

function equalPackages(left: ReturnType<typeof skillPackage>, right: ReturnType<typeof skillPackage>): boolean {
  const paths = [...Object.keys(left.files), ...Object.keys(left.assets)]
  if (paths.length !== Object.keys(right.files).length + Object.keys(right.assets).length) return false
  return paths.every(path => {
    const text = left.files[path]
    const encoded = left.assets[path]?.content
    if (Object.hasOwn(right.files, path)) {
      return text === undefined ? Buffer.from(right.files[path]).toString('base64') === encoded : text === right.files[path]
    }
    const asset = right.assets[path]
    return asset?.encoding === 'base64' && asset.content === (encoded ?? Buffer.from(text).toString('base64'))
  })
}

function sameAsPackage(filePath: string, pkg: ReturnType<typeof skillPackage>): boolean {
  try { return equalPackages(withoutIncidentalFiles(readSkillPackage(filePath)), pkg) }
  catch { return false }
}

function namespacedSpecId(spec: SkillSpec): string {
  return `skill:${createHash('sha256').update(skillSourceIdentity(spec)).digest('hex')}:${spec.name}`
}

function fileExists(filePath: string): boolean {
  try {
    lstatSync(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function readPersonalSkill(app: InstalledApp): InstalledApp {
  if (app.spec.type !== 'skill' || classifySkillSource(app.spec) !== 'personal'
    || !app.userOverrides.skill || app.userOverrides.skill.deleted) return app
  try {
    const pkg = readSkillPackage(app.userOverrides.skill.filePath)
    const content = pkg.files['SKILL.md']
    const metadata = parseSkillMetadata(content, app.spec.name)
    return { ...app, spec: {
      ...app.spec,
      name: metadata.name,
      description: metadata.description || app.spec.description,
      skill_content: content, skill_files: pkg.files, skill_assets: pkg.assets, skill_modes: pkg.modes,
    } }
  } catch (error) {
    console.warn('[SkillLifecycle] Personal skill detail is unavailable', { appId: app.id, error })
    return { ...app, spec: storedSkillSpec(app.spec), userOverrides: {
      ...app.userOverrides,
      skill: { ...app.userOverrides.skill, migrationWarning: error instanceof Error ? error.message : String(error) },
    } }
  }
}

export function createSkillLifecycle(deps: AppManagerDeps) {
  const { store, getSpacePath, getGlobalAppDir } = deps
  const removals = new Map<string, Promise<void>>()

  function pathFor(app: Pick<InstalledApp, 'id' | 'spaceId'>, spec: SkillSpec): string {
    const workDir = app.spaceId === null ? null : getSpacePath(app.spaceId)
    if (app.spaceId !== null && !workDir) throw new SpaceNotFoundError(app.spaceId)
    return skillFilePath(workDir, spec.name)
  }

  function stateFor(app: InstalledApp): SkillInstallationState {
    if (removals.has(app.id)) throw new Error('The skill is being deleted. Wait for deletion to finish.')
    const state = app.userOverrides.skill
    if (!state) throw new Error('Open the skill library to migrate this legacy skill before changing its files.')
    if (state.deleted) throw new Error('This skill was deleted. Explicitly reinstall it before changing its files.')
    return state
  }

  function findInstallation(spec: SkillSpec, spaceId: string | null, excludeId?: string): InstalledApp | undefined {
    return store.listSkillRecords(spaceId).find(candidate => candidate.id !== excludeId
      && candidate.spec.type === 'skill' && candidate.spec.name === spec.name && sameSkillSource(candidate.spec, spec))
  }

  function specIdFor(spec: SkillSpec, spaceId: string | null, app?: InstalledApp): string {
    const previous = app?.spec
    const namespaced = classifySkillSource(spec) !== 'personal'
      || (previous?.type === 'skill' && app?.specId === namespacedSpecId(previous))
    const specId = app && app.spec.name === spec.name ? app.specId : namespaced ? namespacedSpecId(spec) : spec.name
    if (specId !== spec.name) return specId
    const occupant = store.getBySpecAndSpace(specId, spaceId)
    return occupant && occupant.id !== app?.id && occupant.spec.type === 'skill' && !sameSkillSource(occupant.spec, spec)
      ? namespacedSpecId(spec) : specId
  }

  function assertNameAvailable(app: InstalledApp, spec: SkillSpec, spaceId = app.spaceId): void {
    const existing = findInstallation(spec, spaceId, app.id)
    const occupant = store.getBySpecAndSpace(specIdFor(spec, spaceId, app), spaceId)
    if (existing || (occupant && occupant.id !== app.id)) {
      console.warn('[SkillLifecycle] Skill change conflicts with an existing installation', {
        appId: app.id, conflictId: existing?.id ?? occupant?.id, spaceId,
      })
      throw new AppAlreadyInstalledError(spec.name, spaceId)
    }
  }

  /** Whether another live installation already owns this skill folder. */
  function claimedByAnother(filePath: string, spaceId: string | null, ownId?: string): boolean {
    return store.listSkillRecords(spaceId).some(other => {
      const state = other.userOverrides.skill
      return other.id !== ownId && !!state?.filePath && !state.deleted && other.status !== 'uninstalled'
        && resolve(state.filePath) === resolve(filePath)
    })
  }

  /** A skill moves only into a free place: whatever already stands there is someone else's. */
  function refuseOccupied(target: string, name: string, spaceId: string | null): void {
    if (!fileExists(skillRemovalPath(target))) return
    console.warn('[SkillLifecycle] Skill stays where it is; its new place already holds a skill', { spaceId })
    throw new AppAlreadyInstalledError(name, spaceId)
  }

  function commit(app: InstalledApp): void {
    if (app.spec.type !== 'skill') throw new Error('Only skill records can be committed')
    store.updateSkillRecord({ ...app, spec: storedSkillSpec(app.spec) })
  }

  function discardCreated(filePath: string, revision: string, appId: string): void {
    try {
      if (skillRevision(filePath) !== revision) throw new Error('Created skill changed before rollback')
      rmSync(skillRemovalPath(filePath), { recursive: true })
    } catch (error) {
      console.error('[SkillLifecycle] Install rollback left recoverable files', { appId, error })
    }
  }

  return {
    install(spaceId: string | null, spec: SkillSpec, userConfig?: Record<string, unknown>): { app: InstalledApp; reused: boolean } {
      const match = findInstallation(spec, spaceId)
      const existing = match ? store.getById(match.id)! : undefined
      const specId = specIdFor(spec, spaceId, existing)
      const occupant = store.getBySpecAndSpace(specId, spaceId)
      if (occupant && occupant.id !== existing?.id) {
        console.warn('[SkillLifecycle] Install conflicts with an occupied installation key', { conflictId: occupant.id, spaceId })
        throw new AppAlreadyInstalledError(spec.name, spaceId)
      }
      const pkg = skillPackage(spec)
      if (existing && existing.spec.type === 'skill') {
        if (removals.has(existing.id)) throw new Error('The skill is being deleted. Wait for deletion to finish.')
        if (!existing.userOverrides.skill && existing.status !== 'uninstalled') throw new Error('Open the skill library to migrate the existing skill before installing it again.')
        const retained = existing.status !== 'uninstalled' && !existing.userOverrides.skill?.deleted
        const current = retained ? readSkillPackage(existing.userOverrides.skill!.filePath)
          : classifySkillSource(existing.spec) !== 'personal' ? skillPackage(existing.spec) : undefined
        if (current && !equalPackages(current, pkg)) {
          console.warn('[SkillLifecycle] Install requires explicit replacement of different content', { appId: existing.id, spaceId })
          throw new AppAlreadyInstalledError(spec.name, spaceId)
        }
        if (retained) return { app: existing, reused: true }
      }
      const app: InstalledApp = existing ? {
        ...existing, spec, status: 'active', uninstalledAt: undefined,
        userConfig: userConfig ?? existing.userConfig,
      } : {
        id: uuidv4(), specId, spaceId, spec, status: 'active',
        userConfig: userConfig ?? {}, userOverrides: {}, permissions: { granted: [], denied: [] },
        installedAt: Date.now(), upgradeStrategy: 'auto', knowledgeSeeded: false,
      }
      const filePath = pathFor(app, spec)
      // One folder serves every origin, so an occupant that is not this package belongs to the user and is never replaced.
      const occupied = fileExists(skillRemovalPath(filePath)) && classifySkillSource(spec) !== 'personal'
      if (occupied && (claimedByAnother(filePath, spaceId, existing?.id) || !sameAsPackage(filePath, pkg))) {
        console.warn('[SkillLifecycle] Install left an existing skill of the same name untouched', { appId: app.id, spaceId })
        throw new AppAlreadyInstalledError(spec.name, spaceId)
      }
      if (!occupied) writeSkillPackage(filePath, pkg.files, pkg.assets, undefined, spec.skill_modes)
      const written = readSkillPackage(filePath)
      const revision = written.revision
      app.spec = storedSkillSpec({ ...spec, skill_content: undefined, skill_files: pkg.files, skill_assets: pkg.assets })
      app.userOverrides = { ...app.userOverrides, skill: {
        version: 1, filePath, digest: skillPackageDigest(written), owners: existing?.userOverrides.skill?.owners,
      } }
      try {
        if (existing) commit(app)
        else store.insert(app)
      } catch (error) {
        if (!occupied) discardCreated(filePath, revision, app.id)
        console.error('[SkillLifecycle] Install record failed after writing package', { appId: app.id, error })
        throw error
      }
      return { app, reused: false }
    },

    update(app: InstalledApp, patch: Record<string, unknown>, authorUpdate = false): void {
      if (app.spec.type !== 'skill') throw new Error('Only skills have skill packages')
      const state = stateFor(app)
      const original = readSkillPackage(state.filePath)
      const current = classifySkillSource(app.spec) === 'personal'
        ? { ...app.spec, skill_files: original.files, skill_assets: original.assets, skill_content: original.files['SKILL.md'] }
        : app.spec
      const merged: Record<string, unknown> = { ...current }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key]
        else merged[key] = value
      }
      if (typeof patch.skill_content === 'string' && !Object.hasOwn(patch, 'skill_files')) {
        merged.skill_files = { ...original.files, 'SKILL.md': patch.skill_content }
      }
      const replacePackage = authorUpdate || (patch.type === 'skill' && Object.hasOwn(patch, 'version'))
      if (replacePackage) {
        if (!Object.hasOwn(patch, 'skill_files')) delete merged.skill_files
        if (!Object.hasOwn(patch, 'skill_assets')) delete merged.skill_assets
        if (!Object.hasOwn(patch, 'skill_content')) delete merged.skill_content
      }
      const next = validateAppSpec(merged)
      if (next.type !== 'skill') throw new Error('A skill cannot be changed to another app type')
      if (!sameSkillSource(app.spec, next)) throw new Error('Changing a skill source requires an independent installation')
      assertNameAvailable(app, next)
      const instructionsOnly = !replacePackage && !Object.hasOwn(patch, 'skill_files') && !Object.hasOwn(patch, 'skill_assets')
      const pkg = instructionsOnly ? {
        files: { ...original.files, 'SKILL.md': next.name !== app.spec.name
          ? setSkillMdName(typeof patch.skill_content === 'string' ? patch.skill_content : original.files['SKILL.md'], next.name)
          : typeof patch.skill_content === 'string' ? patch.skill_content : original.files['SKILL.md'] },
        assets: original.assets,
      } : skillPackage(next)
      const target = next.name !== app.spec.name ? pathFor(app, next) : state.filePath
      const moved = resolve(target) !== resolve(state.filePath)
      if (moved) {
        refuseOccupied(target, next.name, app.spaceId)
        moveSkillFiles(state.filePath, target, original.revision)
      }
      let writtenRevision: string | undefined
      try {
        const revision = moved ? skillRevision(target) : original.revision
        if (instructionsOnly) writeSkillContent(target, pkg.files['SKILL.md'], revision)
        else writeSkillPackage(target, pkg.files, pkg.assets, revision, next.skill_modes)
        const written = readSkillPackage(target)
        writtenRevision = written.revision
        commit({ ...app, specId: specIdFor(next, app.spaceId, app), spec: { ...next, skill_content: undefined, skill_files: pkg.files, skill_assets: pkg.assets },
          userOverrides: { ...app.userOverrides, skill: {
            ...state, filePath: target, digest: skillPackageDigest(written),
            customized: classifySkillSource(next) === 'personal' ? undefined : !authorUpdate,
          } },
        })
      } catch (error) {
        try {
          if (writtenRevision) {
            if (instructionsOnly) writeSkillContent(target, original.files['SKILL.md'], writtenRevision)
            else writeSkillPackage(target, original.files, original.assets, writtenRevision, original.modes)
          }
          if (moved) moveSkillFiles(target, state.filePath, skillRevision(target))
        } catch (rollbackError) {
          console.error('[SkillLifecycle] Update rollback failed; package retained for recovery', { appId: app.id, rollbackError })
        }
        console.error('[SkillLifecycle] Update failed', { appId: app.id, error })
        throw error
      }
    },

    move(app: InstalledApp, spaceId: string | null): void {
      if (app.spec.type !== 'skill') throw new Error('Only skills have skill packages')
      const state = stateFor(app)
      assertNameAvailable(app, app.spec, spaceId)
      const target = pathFor({ ...app, spaceId }, app.spec)
      const moved = resolve(target) !== resolve(state.filePath)
      if (moved) {
        refuseOccupied(target, app.spec.name, spaceId)
        moveSkillFiles(state.filePath, target, skillRevision(state.filePath))
      }
      try {
        commit({ ...app, specId: specIdFor(app.spec, spaceId, app), spaceId,
          userOverrides: { ...app.userOverrides, skill: { ...state, filePath: target } },
        })
      } catch (error) {
        if (moved) {
          try { moveSkillFiles(target, state.filePath, skillRevision(target)) }
          catch (rollbackError) { console.error('[SkillLifecycle] Move rollback failed', { appId: app.id, rollbackError }) }
        }
        throw error
      }
    },

    setAvailability(app: InstalledApp, enabled: boolean): void {
      if (app.spec.type !== 'skill' || classifySkillSource(app.spec) !== 'personal') return
      const state = stateFor(app)
      const identity = canonicalSkillPath(state.filePath)
      writeSkillPreference(getGlobalAppDir(), identity, { ...readSkillPreference(getGlobalAppDir(), identity), enabled })
    },

    /** True when the user changed a managed skill's files outside Halo since Halo last wrote them. */
    editedOutside(app: InstalledApp): boolean {
      const state = app.userOverrides.skill
      if (app.spec.type !== 'skill' || !state?.digest || state.deleted) return false
      try { return skillPackageDigest(readSkillPackage(state.filePath)) !== state.digest }
      catch { return false }
    },

    assertAvailable(app: InstalledApp): void {
      const state = stateFor(app)
      skillRevision(state.filePath)
    },

    reinstall(app: InstalledApp): void {
      if (app.spec.type !== 'skill') throw new Error('Only skills can be reinstalled here')
      if (!app.userOverrides.skill) throw new Error('Use legacy skill recovery before reinstalling this skill')
      if (classifySkillSource(app.spec) === 'personal') {
        skillRevision(app.userOverrides.skill.filePath)
        commit({ ...app, status: 'active', userOverrides: { ...app.userOverrides,
          skill: { ...app.userOverrides.skill, deleted: false },
        } })
      } else {
        this.install(app.spaceId, app.spec)
      }
    },

    trash(app: InstalledApp): Promise<void> {
      const pending = removals.get(app.id)
      if (pending) return pending
      if (app.userOverrides.skill?.deleted) return Promise.resolve()
      const operation = (async () => {
        const state = app.userOverrides.skill
        if (!state) throw new Error('Use legacy skill recovery before deleting this skill')
        const target = skillRemovalPath(state.filePath)
        if (fileExists(target)) {
          const selected = prepareSkillRemoval(state.filePath)
          await (deps.trashItem ?? (path => shell.trashItem(path)))(selected)
        } else {
          console.warn('[SkillLifecycle] Deleting record for an already missing skill', { appId: app.id })
        }
        commit({ ...app, status: 'uninstalled', userOverrides: { ...app.userOverrides,
          skill: { ...state, deleted: true },
        } })
      })().catch(error => {
        console.error('[SkillLifecycle] Trash failed; no permanent-delete fallback', { appId: app.id, error })
        throw error
      }).finally(() => removals.delete(app.id))
      removals.set(app.id, operation)
      return operation
    },

    updateRecord(app: InstalledApp, change: { spec?: SkillSpec; skill?: SkillInstallationState; spaceId?: string | null; status?: AppStatus }): void {
      if (app.spec.type !== 'skill' || (change.spec && change.spec.type !== 'skill')) throw new Error('Only skill records can be updated')
      const spec = change.spec ?? app.spec
      if (!sameSkillSource(app.spec, spec)) {
        console.warn('[SkillLifecycle] Record update refused a change of source', { appId: app.id })
        throw new Error('Changing a skill source requires an independent installation')
      }
      const spaceId = change.spaceId === undefined ? app.spaceId : change.spaceId
      const next: InstalledApp = { ...app, spec, specId: specIdFor(spec, spaceId, app), spaceId,
        status: change.status ?? app.status,
        userOverrides: { ...app.userOverrides, skill: change.skill ?? app.userOverrides.skill },
      }
      if (change.skill && (change.skill.version !== 1 || (!change.skill.filePath && !change.skill.deleted))) throw new Error('Invalid skill installation state')
      assertNameAvailable(app, spec, spaceId)
      commit(next)
    },
  }
}
