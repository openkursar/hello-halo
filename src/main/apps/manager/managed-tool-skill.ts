import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { SkillInstallationState } from '../../../shared/types/skills'
import {
  canonicalSkillPath, classifySkillSource, moveSkillFiles, parseSkillMetadata, prepareSkillRemoval, readSkillPackage, skillFilePath,
  skillPackageDigest, skillPackageFromBytes, skillSearchRoots, validateSkillName, writeSkillContent, writeSkillPackage,
} from '../../services/skills'
import type { SkillPackage } from '../../services/skills'
import type { SkillSpec } from '../spec'
import type { AppManagerDeps } from './service'
import type { InstalledApp, ManagedToolSkillInput } from './types'

type ManagedState = SkillInstallationState & { managedTool: NonNullable<SkillInstallationState['managedTool']> }

const STAGING_FOLDER = '.halo-managed-tool-skills'

/** One record per tool installation; records from before installation ids are keyed by the tool alone. */
function recordId(toolId: string, installId?: string): string {
  const key = installId ? `${toolId}\u0000${installId}` : toolId
  return `managed-tool-skill:${createHash('sha256').update(key).digest('hex')}`
}

function entryOf(path: string) {
  try { return lstatSync(path, { bigint: true }) }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
    throw error
  }
}

function directoryEntry(filePath: string) {
  return entryOf(dirname(filePath))
}

function directoryId(entry: NonNullable<ReturnType<typeof directoryEntry>>): string {
  return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`
}

function stagingPath(filePath: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid managed skill staging ID')
  return join(dirname(dirname(filePath)), STAGING_FOLDER, id, 'SKILL.md')
}

/** Fingerprint of everything in a package except SKILL.md, which alone can be rewritten in place. */
function attachmentsDigest(pkg: Pick<SkillPackage, 'files' | 'assets'>): string {
  const files = { ...pkg.files }
  delete files['SKILL.md']
  return skillPackageDigest({ files, assets: pkg.assets })
}

/** The package in the folder Halo wrote, read only while that folder is the same one and unchanged meanwhile. */
function currentPackage(filePath: string, identity: string) {
  const entry = directoryEntry(filePath)
  if (!entry?.isDirectory() || directoryId(entry) !== identity) return undefined
  try {
    const pkg = readSkillPackage(filePath)
    const latest = directoryEntry(filePath)
    if (!latest?.isDirectory() || directoryId(latest) !== identity || latest.ctimeNs !== entry.ctimeNs
      || latest.mtimeNs !== entry.mtimeNs) return undefined
    const digest = skillPackageDigest(pkg)
    return { revision: pkg.revision, digest, attachments: attachmentsDigest(pkg) }
  } catch (error) {
    console.warn('[SkillLifecycle] Managed CLI skill could not be verified', { code: (error as NodeJS.ErrnoException).code })
    return undefined
  }
}

function owns(state: SkillInstallationState, toolId: string): boolean {
  return !!state.owners?.some(owner => owner.kind === 'cli-tool' && owner.id === toolId)
}

export function createManagedToolSkillLifecycle(store: AppManagerDeps['store'], trash: (path: string) => Promise<void>) {
  const pending = new Map<string, Promise<unknown>>()

  function enqueue<T>(toolId: string, work: () => Promise<T>): Promise<T> {
    const previous = pending.get(toolId)
    const task = (previous ? previous.then(work, work) : work()).finally(() => {
      if (pending.get(toolId) === task) pending.delete(toolId)
    })
    pending.set(toolId, task)
    return task
  }

  /** Records whose skill Halo still manages for the tool, of any installation. */
  function ownedRecords(toolId: string): InstalledApp[] {
    return store.listSkillRecords(null).filter(app => {
      const state = stateOf(app, toolId)
      return !!state && owns(state, toolId)
    })
  }

  /** Withdraw one managed skill: the files go to the trash unless the user changed them. */
  async function removeRecord(app: InstalledApp, toolId: string): Promise<void> {
    let state = stateOf(app, toolId)
    if (!state || !owns(state, toolId)) return
    const expected = skillFilePath(null, app.spec.name)
    const reason = protectedReason(app, state, expected)
    if (reason) return relinquish(app, state, reason)
    if (state.managedTool.removalId) return finishRemoval(app, state)
    const { filePath, managedTool } = state
    const target = managedTool.stagingId && !directoryEntry(filePath) ? stagingPath(filePath, managedTool.stagingId) : filePath
    const current = currentPackage(target, managedTool.directoryId)
    if (!current || (current.digest !== managedTool.writtenDigest && current.digest !== managedTool.pendingDigest)) {
      return relinquish(app, state, 'files no longer match the package Halo wrote')
    }
    state = { ...state, managedTool: { ...managedTool, writtenDigest: current.digest,
      stagingId: undefined, pendingDigest: undefined, removalId: managedTool.stagingId && target !== filePath ? managedTool.stagingId : randomUUID(),
    } }
    commit(app, state)
    await finishRemoval(app, state)
  }

  /** The file Halo manages under `id` once nothing is in flight, or null. */
  function managedPath(id: string, toolId: string): string | null {
    const app = store.getById(id)
    const state = app && stateOf(app, toolId)
    if (!app || !state || !owns(state, toolId) || state.deleted || app.status !== 'active') return null
    const { stagingId, removalId } = state.managedTool
    return stagingId || removalId ? null : state.filePath
  }

  function commit(app: InstalledApp, state: ManagedState, change?: Partial<Pick<InstalledApp, 'status' | 'uninstalledAt' | 'spec'>>): void {
    store.updateSkillRecord({ ...app, ...change, userOverrides: { ...app.userOverrides, skill: state } })
  }

  function relinquish(app: InstalledApp, state: ManagedState, reason: string): void {
    const { toolId } = state.managedTool
    commit(app, {
      ...state, customized: true, managedTool: { ...state.managedTool, pendingDigest: undefined, stagingId: undefined, removalId: undefined },
      owners: state.owners?.filter(owner => owner.kind !== 'cli-tool' || owner.id !== toolId),
    })
    console.warn('[SkillLifecycle] Preserved CLI skill and dropped tool ownership', { toolId, reason })
  }

  function stateOf(app: InstalledApp, toolId: string): ManagedState | undefined {
    const state = app.userOverrides.skill
    return app.spec.type === 'skill' && state?.managedTool?.toolId === toolId ? state as ManagedState : undefined
  }

  function hasPersonalNamesake(name: string, state: ManagedState): boolean {
    const managedPath = canonicalSkillPath(state.filePath)
    const entry = directoryEntry(state.filePath)
    const ownsDirectory = entry?.isDirectory() && directoryId(entry) === state.managedTool.directoryId
    const candidates = new Set<string>()
    for (const { path } of skillSearchRoots(null)) {
      for (const candidate of [join(path, name, 'SKILL.md'), join(path, `${name}.md`)]) {
        if (!entryOf(candidate)) continue
        const canonical = canonicalSkillPath(candidate)
        if (!ownsDirectory || canonical !== managedPath) candidates.add(canonical)
      }
    }
    if (!candidates.size) return false
    for (const other of store.listSkillRecords(null)) {
      const skill = other.userOverrides.skill
      if (other.spec.type === 'skill' && classifySkillSource(other.spec) !== 'personal'
        && other.status !== 'uninstalled' && skill?.filePath && !skill.deleted && skill.filePath !== state.filePath) {
        candidates.delete(canonicalSkillPath(skill.filePath))
      }
    }
    return candidates.size > 0
  }

  function protectedReason(app: InstalledApp, state: ManagedState, expected: string): string | undefined {
    if (app.spaceId !== null || resolve(state.filePath) !== resolve(expected)) return 'skill moved or renamed'
    if (state.owners?.length !== 1) return 'skill is shared with another owner'
    if (hasPersonalNamesake(app.spec.name, state)) return 'a personal skill has the same name'
    if (!state.managedTool.stagingId && !state.managedTool.removalId && state.digest !== state.managedTool.writtenDigest) {
      return 'skill metadata no longer matches the managed baseline'
    }
    if (state.customized || (!state.managedTool.stagingId && !state.managedTool.removalId && (state.deleted || app.status === 'uninstalled'))) {
      return 'skill was customized or removed'
    }
  }

  function finishInstall(app: InstalledApp, state: ManagedState): boolean {
    const { stagingId, directoryId, writtenDigest } = state.managedTool
    if (!stagingId) return true
    if (hasPersonalNamesake(app.spec.name, state)) {
      relinquish(app, state, 'a personal skill has the same name')
      return false
    }
    const filePath = state.filePath
    const staged = stagingPath(filePath, stagingId)
    if (!directoryEntry(filePath)) {
      const candidate = currentPackage(staged, directoryId)
      if (candidate?.digest !== writtenDigest) {
        relinquish(app, state, 'staged install could not be proven')
        return false
      }
      moveSkillFiles(staged, filePath, candidate.revision)
    }
    if (currentPackage(filePath, directoryId)?.digest !== writtenDigest) {
      relinquish(app, state, 'install destination contains another skill')
      return false
    }
    commit(app, { ...state, deleted: false, managedTool: { ...state.managedTool, stagingId: undefined } },
      { status: 'active', uninstalledAt: undefined })
    return true
  }

  async function finishRemoval(app: InstalledApp, state: ManagedState): Promise<void> {
    const { removalId, directoryId, writtenDigest } = state.managedTool
    const filePath = state.filePath
    const staged = stagingPath(filePath, removalId!)
    const existing = currentPackage(filePath, directoryId)
    if (existing?.digest === writtenDigest && !directoryEntry(staged)) moveSkillFiles(filePath, staged, existing.revision)
    const candidate = currentPackage(staged, directoryId)
    if (candidate?.digest === writtenDigest) {
      try {
        await trash(prepareSkillRemoval(staged, candidate.revision))
      } catch (error) {
        if (!directoryEntry(filePath) && currentPackage(staged, directoryId)?.digest === writtenDigest) {
          moveSkillFiles(staged, filePath, candidate.revision)
        }
        throw error
      }
    } else if (directoryEntry(staged) || directoryEntry(filePath)) {
      relinquish(app, state, 'removal destination or source changed')
      return
    }
    const latest = store.getById(app.id)
    const latestState = latest && stateOf(latest, state.managedTool.toolId)
    if (latest && latestState && latestState.managedTool.removalId === removalId) {
      if (latestState.owners?.length === 1 && owns(latestState, state.managedTool.toolId)) store.delete(app.id)
      else relinquish(latest, latestState, 'ownership changed during removal')
    }
  }

  function create(
    id: string, spec: SkillSpec, toolId: string, installId: string, filePath: string,
    pkg: Pick<SkillPackage, 'files' | 'assets'>, digest: string,
  ): void {
    const occupied = skillSearchRoots(null).some(({ path }) =>
      !!entryOf(join(path, spec.name)) || !!entryOf(join(path, `${spec.name}.md`)))
    if (occupied || store.getBySpecAndSpace(spec.name, null)) {
      console.warn('[SkillLifecycle] Kept existing skill instead of installing CLI skill', { toolId })
      return
    }
    const stagingId = randomUUID()
    const staged = stagingPath(filePath, stagingId)
    writeSkillPackage(staged, pkg.files, pkg.assets)
    const entry = directoryEntry(staged)
    if (!entry?.isDirectory()) throw new Error('Managed CLI skill staging directory could not be verified')
    const state: ManagedState = {
      version: 1, filePath, deleted: true, digest,
      owners: [{ kind: 'cli-tool', id: toolId, name: toolId }],
      managedTool: { toolId, installId, directoryId: directoryId(entry), writtenDigest: digest, stagingId },
    }
    const app: InstalledApp = {
      id, specId: id, spec, spaceId: null, status: 'uninstalled', installedAt: Date.now(),
      userConfig: {}, userOverrides: { skill: state }, permissions: { granted: [], denied: [] },
      upgradeStrategy: 'manual', knowledgeSeeded: false,
    }
    // Commit provenance before publication; the staging directory keeps its identity across the rename.
    try {
      store.insert(app)
    } catch (error) {
      console.warn('[SkillLifecycle] Preserved unpublished CLI skill after record failure', { toolId })
      throw error
    }
    finishInstall(app, state)
  }

  async function reconcile(input: ManagedToolSkillInput): Promise<void> {
    const { toolId, installId, description, body } = input
    const name = validateSkillName(input.name)
    const id = recordId(toolId, installId)
    const filePath = skillFilePath(null, name)
    const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`
    if (!toolId.trim() || !installId.trim() || !description.trim() || parseSkillMetadata(content, name).error ||
      input.attachments?.some(file => file.path === 'SKILL.md')) {
      throw new Error('Invalid managed CLI skill input')
    }
    const pkg = skillPackageFromBytes([
      ['SKILL.md', Buffer.from(content, 'utf-8')],
      ...(input.attachments ?? []).map(file => [file.path, file.bytes] as [string, Uint8Array]),
    ])
    // A skill of an earlier installation, or one from before installations had ids, makes way first.
    for (const earlier of ownedRecords(toolId)) {
      if (earlier.id !== id) await removeRecord(earlier, toolId)
    }
    const spec: SkillSpec = {
      type: 'skill', name, description, version: '1', spec_version: '1',
      store: { install_source: 'store', registry_id: id, tags: [] }, skill_files: { 'SKILL.md': content },
    }
    const digest = skillPackageDigest(pkg)
    let app = store.getById(id)
    if (!app) {
      create(id, spec, toolId, installId, filePath, pkg, digest)
      return
    }
    let state = stateOf(app, toolId)
    if (!state || !owns(state, toolId)) return
    const reason = protectedReason(app, state, filePath)
    if (reason) return relinquish(app, state, reason)
    if (state.managedTool.removalId) {
      await finishRemoval(app, state)
      if (!store.getById(id)) create(id, spec, toolId, installId, filePath, pkg, digest)
      return
    }
    if (state.managedTool.stagingId) {
      if (!finishInstall(app, state)) return
      app = store.getById(id)!
      state = stateOf(app, toolId)!
    }
    const { managedTool } = state
    const current = currentPackage(filePath, managedTool.directoryId)
    if (!current || (current.digest !== managedTool.writtenDigest && current.digest !== managedTool.pendingDigest)) {
      return relinquish(app, state, 'files no longer match the package Halo wrote')
    }
    if (current.digest !== digest && current.attachments !== attachmentsDigest(pkg)) {
      // Files beside SKILL.md changed: the whole folder is withdrawn and written anew.
      await removeRecord(app, toolId)
      if (!store.getById(id)) create(id, spec, toolId, installId, filePath, pkg, digest)
      return
    }
    if (current.digest !== digest) {
      if (current.digest === managedTool.pendingDigest) {
        state = { ...state, digest: current.digest, managedTool: { ...managedTool, writtenDigest: current.digest, pendingDigest: undefined } }
      }
      const writing = { ...state, managedTool: { ...state.managedTool, pendingDigest: digest } }
      commit(app, writing)
      writeSkillContent(filePath, content, current.revision)
      state = writing
    }
    if (state.managedTool.pendingDigest !== undefined || state.managedTool.writtenDigest !== digest) {
      commit(app, { ...state, digest, managedTool: { ...state.managedTool, writtenDigest: digest, pendingDigest: undefined } }, { spec })
    }
  }

  return {
    reconcileManagedToolSkill(input: ManagedToolSkillInput): Promise<string | null> {
      return enqueue(input.toolId, async () => {
        await reconcile(input)
        return managedPath(recordId(input.toolId, input.installId), input.toolId)
      })
    },

    removeManagedToolSkill(toolId: string): Promise<void> {
      return enqueue(toolId, async () => {
        for (const app of ownedRecords(toolId)) await removeRecord(app, toolId)
      })
    },

    /**
     * Folders of the tool skills Halo installed and still manages, whose files
     * are exactly what it wrote. Nothing in flight, customized or moved counts.
     */
    listManagedToolSkillFolders(): string[] {
      const folders: string[] = []
      for (const app of store.listSkillRecords(null)) {
        const state = app.userOverrides.skill
        const toolId = state?.managedTool?.toolId
        if (!toolId || app.spec.type !== 'skill' || app.status !== 'active' || pending.has(toolId)) continue
        const managed = stateOf(app, toolId)
        if (!managed || !owns(managed, toolId) || managed.deleted || managed.customized) continue
        const { stagingId, removalId, directoryId, writtenDigest } = managed.managedTool
        if (stagingId || removalId || managed.digest !== writtenDigest) continue
        if (currentPackage(managed.filePath, directoryId)?.digest !== writtenDigest) continue
        // Both spellings, so a folder reached through a linked home directory still matches.
        folders.push(dirname(managed.filePath), dirname(canonicalSkillPath(managed.filePath)))
      }
      return [...new Set(folders)]
    },
  }
}
