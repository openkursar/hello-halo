/**
 * The app's one CLI tool store. Each usable tool has launchers at a fixed
 * path and a skill that names it; sessions and terminals get nothing added to
 * their environment.
 *
 * Bootstrap calls `initCliTools` with paths only; nothing touches the disk
 * until the idle task prepares the store or a management call needs it. Every
 * failure logs and leaves the tools as they were: a broken tool store never
 * stops a conversation or a terminal from starting.
 */

import { randomUUID } from 'crypto'
import { existsSync, promises as fsp } from 'fs'
import { join } from 'path'
import { Emitter } from '../../platform/event'
import {
  CliToolStore,
  EXTERNAL_VERSION,
  commandOnPath,
  compareVersions,
  toolBlock,
  type CatalogToolStatus,
  type CliToolSkillSummary,
  type CliToolState,
  type ImportResult,
  type PackagePreview,
  type RegisterExternalOptions,
} from './store'
import { CliToolError, isCliToolError, type CliToolErrorCode } from './errors'
import type { CliCredentialBinding } from './credentials'
import type { CliSupportFilesConfig } from './support-files'
import { PRESET_CATALOG_FILE, readPresetCatalog, type PresetCatalog } from './preset-catalog'
import { BUNDLE_MAX_BYTES, readBundle, type BundleReference } from './bundle'
import { TRUSTED_KEYS_FILE, loadTrustStore, type TrustMode } from './signature'
import type {
  CliDeliveryFailureView,
  CliToolView,
  CliToolsOverview,
  CliToolVersionView,
} from '../../../shared/types/cli-tools'

export interface CliToolsHostOptions {
  /** Store root, e.g. `<userData>/cli`. */
  root: string
  /** Executable launched as Node. */
  runtimePath: string
  /** Directory of the delivery bundles (and plain `.hcli` packages) shipped with the build; null when it has none. */
  presetDir: string | null
  /** Tools whose process receives a host-held credential; supplied by the caller, never read here. */
  credentialBindings?: CliCredentialBinding[]
  supportFiles?: CliSupportFilesConfig
}

/** A usable tool an organization supplied (bundled or delivered) whose skill is installed. */
export interface OrganizationTool {
  toolId: string
  name: string
  skillName: string
}

let options: CliToolsHostOptions | null = null
let store: CliToolStore | null = null
let prepared: Promise<void> | null = null
const currentToolsChanged = new Emitter<string>()
let currentToolBatchDepth = 0
let batchedRevision: string | undefined
let organizationTools: readonly OrganizationTool[] = []

/** Fires after a committed change to the current usable tool set. */
export const onDidChangeCurrentTools = currentToolsChanged.event

/** Publish one current-set notification for a catalog delivery pass. */
export async function batchCurrentToolChanges<T>(task: () => Promise<T>): Promise<T> {
  currentToolBatchDepth += 1
  try {
    return await task()
  } finally {
    if (--currentToolBatchDepth === 0 && batchedRevision !== undefined) {
      const revision = batchedRevision
      batchedRevision = undefined
      currentToolsChanged.fire(revision)
    }
  }
}

export function getPreparedCurrentToolsRevision(): string | undefined {
  return store?.preparedCurrentToolsRevision
}

export function readCurrentToolSkills() {
  return getStore()?.readCurrentToolSkills()
}

/**
 * Record in a tool's installation where its skill went, or that it has none
 * (the skill could not be installed or was given up to the user). Also
 * refreshes the organization tools the agent is told about.
 */
export async function recordCliToolSkill(toolId: string, installId: string, skill: { name: string; path: string } | null): Promise<void> {
  const cliStore = getStore()
  if (!cliStore) return
  try {
    await cliStore.recordSkillLocation(toolId, installId, skill)
  } catch (err) {
    console.error('[CliTools] Skill location not recorded', { tool: toolId, message: err instanceof Error ? err.message : String(err) })
  }
  await refreshOrganizationTools()
}

/** Organization tools with an installed skill, from memory; empty until the store is prepared. */
export function peekOrganizationTools(): readonly OrganizationTool[] {
  return organizationTools
}

async function refreshOrganizationTools(): Promise<void> {
  const cliStore = getStore()
  if (!cliStore) return
  try {
    const state = await cliStore.readState()
    const next: OrganizationTool[] = []
    for (const [toolId, tool] of Object.entries(state.tools).sort(([a], [b]) => a.localeCompare(b))) {
      const record = tool.current ? tool.versions[tool.current] : undefined
      if (toolBlock(tool) !== null || !record || (record.source !== 'preset' && record.source !== 'catalog')) continue
      const install = await cliStore.readInstallRecord(toolId)
      if (!install?.skill || install.installId !== tool.installId) continue
      next.push({ toolId, name: record.name ?? toolId, skillName: install.skill.name })
    }
    organizationTools = next
  } catch (err) {
    console.error('[CliTools] Organization tools could not be read', { message: err instanceof Error ? err.message : String(err) })
  }
}

export function initCliTools(hostOptions: CliToolsHostOptions): void {
  options = hostOptions
}

function getStore(): CliToolStore | null {
  if (!options) return null
  if (!store) {
    store = new CliToolStore({
      root: options.root,
      runtimePath: options.runtimePath,
      runtimeNodeVersion: process.versions.node,
      credentialBindings: options.credentialBindings,
      supportFiles: options.supportFiles,
    })
    store.onDidChangeCurrentTools(revision => {
      void refreshOrganizationTools()
      if (currentToolBatchDepth > 0) batchedRevision = revision
      else currentToolsChanged.fire(revision)
    })
  }
  return store
}

/**
 * Delete versions removed while an earlier process could still run them,
 * import the packages shipped with this build, and bring every launcher up to
 * date. Runs once, from the idle task or the first management call.
 */
export function prepareCliTools(): Promise<void> {
  if (!prepared) prepared = runPrepare()
  return prepared
}

async function runPrepare(): Promise<void> {
  const cliStore = getStore()
  if (!cliStore || !options) return
  try {
    await cliStore.collectPendingCleanup()
    await fsp.rm(join(options.root, 'downloads'), { recursive: true, force: true })
    if (options.presetDir) await importPresets(cliStore, options.presetDir, options.root)
    await cliStore.syncLaunchers()
    await refreshOrganizationTools()
  } catch (err) {
    console.error('[CliTools] Preparing the tool store failed; sessions continue without changes', {
      code: isCliToolError(err) ? err.code : 'UNEXPECTED',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

interface PresetStamp {
  files: Array<{ name: string; size: number; mtimeMs: number }>
}

/**
 * Import what the build ships in its preset directory: delivery bundles
 * (`*.zip`), each checked against the build's catalog snapshot exactly as a
 * catalog download is, and plain `.hcli` packages, which carry no skill of
 * their own. A preset becomes current only when the tool has no current
 * version or its current version also came from a preset; a bundle further
 * needs to be newly installed and above the current version, so an older
 * build never takes back a version a newer one or the catalog set. An
 * unchanged preset directory is skipped by its stamp, so later launches
 * re-hash nothing.
 */
async function importPresets(cliStore: CliToolStore, presetDir: string, root: string): Promise<void> {
  if (!existsSync(presetDir)) return
  const entries = await fsp.readdir(presetDir)
  const names = entries.filter(name => name.endsWith('.hcli') || name.endsWith('.zip')).sort()
  if (names.length === 0) return
  const metadata = entries.filter(name => name === PRESET_CATALOG_FILE || name === TRUSTED_KEYS_FILE)
  const files: PresetStamp['files'] = []
  for (const name of [...names, ...metadata]) {
    const stat = await fsp.stat(join(presetDir, name))
    files.push({ name, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) })
  }
  const stampFile = join(root, 'preset-stamp.json')
  const stamp = JSON.stringify({ files } satisfies PresetStamp)
  const previous = await fsp.readFile(stampFile, 'utf-8').catch(() => '')
  if (previous === stamp) return

  let failures = 0
  let catalog: PresetCatalog | undefined
  if (entries.includes(PRESET_CATALOG_FILE)) {
    try {
      catalog = await readPresetCatalog(join(presetDir, PRESET_CATALOG_FILE))
    } catch (err) {
      failures += 1
      console.error('[CliTools] Bundled CLI catalog unreadable; bundled bundles are not imported', {
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  for (const name of names) {
    try {
      const state = await cliStore.readState()
      const bundled = name.endsWith('.zip')
      const result = bundled
        ? await importPresetBundle(cliStore, presetDir, name, catalog)
        : await cliStore.importPackage(join(presetDir, name), { source: 'preset', activate: false })
      const tool = (await cliStore.readState()).tools[result.id]
      const current = state.tools[result.id]?.current
      const canActivate = !bundled ||
        (result.installed && !tool?.revoked && (!current || compareVersions(result.version, current) > 0))
      if (canActivate && shouldActivatePreset(state, result.id, result.version) && tool && tool.current !== result.version) {
        await cliStore.activateVersion(result.id, result.version)
      }
    } catch (err) {
      failures += 1
      console.error('[CliTools] Bundled tool not imported; the installed versions are unchanged', {
        file: name,
        code: isCliToolError(err) ? err.code : 'UNEXPECTED',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // A failed preset is retried on the next launch.
  if (failures === 0) {
    await fsp.mkdir(root, { recursive: true })
    await fsp.writeFile(stampFile, stamp, 'utf-8')
  }
  console.log('[CliTools] Bundled tools checked', { packages: names.length, failures })
}

async function importPresetBundle(
  cliStore: CliToolStore,
  presetDir: string,
  name: string,
  catalog: PresetCatalog | undefined,
): Promise<ImportResult> {
  const ref = catalog?.bundle(name)
  if (!ref) throw new CliToolError('PACKAGE_INVALID', 'bundled bundle is not named by the bundled CLI catalog')
  if (catalog!.revoked(ref.id)) throw new CliToolError('PACKAGE_INVALID', 'bundled CLI catalog marks this tool as revoked')
  return importBundleBytes(cliStore, await readFileWithin(join(presetDir, name), BUNDLE_MAX_BYTES), ref, 'preset', false)
}

async function readFileWithin(file: string, maxBytes: number): Promise<Buffer> {
  const stat = await fsp.stat(file)
  if (stat.size > maxBytes) throw new CliToolError('PACKAGE_INVALID', 'bundle exceeds its size limit')
  return fsp.readFile(file)
}

/**
 * Verify a bundle and import its CLI package with the bundle's revision and
 * skill. Identical installed content only takes the new skill.
 */
async function importBundleBytes(
  cliStore: CliToolStore,
  bytes: Uint8Array,
  ref: BundleReference,
  source: 'preset' | 'catalog',
  activate: boolean,
): Promise<ImportResult> {
  const bundle = await readBundle(bytes, ref, await loadTrustStore(trustFile()))
  const dir = join(options!.root, 'downloads')
  const archive = join(dir, `${randomUUID()}.hcli`)
  await fsp.mkdir(dir, { recursive: true })
  try {
    await fsp.writeFile(archive, bundle.hcli, { flag: 'wx' })
    return await cliStore.importPackage(archive, {
      source,
      expectedArchiveSha256: bundle.cli.archiveSha256,
      expectedIntegrity: bundle.cli.integrity,
      expectedTool: { id: ref.id, version: ref.version },
      activate,
      bundle,
    })
  } finally {
    await fsp.rm(archive, { force: true }).catch(() => undefined)
  }
}

function trustFile(): string | null {
  return options?.presetDir ? join(options.presetDir, TRUSTED_KEYS_FILE) : null
}

/** Whether bundle signatures are checked on this build (see signature.ts). */
export async function catalogSignatureMode(): Promise<TrustMode> {
  return (await loadTrustStore(trustFile())).mode
}

/** Installed tools once the store is prepared; null when the host has no store. */
export async function readCliToolState(): Promise<CliToolState | null> {
  const cliStore = getStore()
  if (!cliStore) return null
  await prepareCliTools()
  return cliStore.readState()
}

/**
 * Install a delivery bundle downloaded from an administrator catalog. The
 * bundle must match the catalog's reference and pass every bundle check; its
 * CLI package then imports with source `catalog` and becomes current, or, when
 * that content is already installed, only its skill and revision change. Any
 * failure leaves the installed versions as they were. A command already
 * running finishes on the version it started with.
 */
export async function installCatalogBundle(bytes: Uint8Array, ref: BundleReference): Promise<ImportResult> {
  const cliStore = getStore()
  if (!cliStore) throw new CliToolError('RUNTIME_MISSING', 'the CLI tool store is not available in this process')
  await prepareCliTools()
  return importBundleBytes(cliStore, bytes, ref, 'catalog', true)
}

/**
 * Apply an administrator catalog's revocation flags to the installed tools it
 * lists, whatever their source; tools the catalog does not list are left
 * alone. A revoked tool loses its launchers and skill; a command already
 * running finishes. Returns the ids whose flag changed.
 */
export async function applyCatalogRevocations(flags: Record<string, boolean>): Promise<string[]> {
  const cliStore = getStore()
  if (!cliStore) return []
  await prepareCliTools()
  const state = await cliStore.readState()
  const changed: string[] = []
  for (const [id, revoked] of Object.entries(flags)) {
    const tool = state.tools[id]
    if (!tool || tool.revoked === revoked) continue
    await cliStore.setRevoked(id, revoked)
    changed.push(id)
  }
  return changed
}

/**
 * Apply a freshly read catalog: revocation, delisting, withdrawn versions and
 * available updates (see `CliToolStore.applyCatalogStatus`). Returns the ids
 * that changed. Call only with a catalog that was actually read.
 */
export async function applyCatalogStatus(catalog: CatalogToolStatus[]): Promise<string[]> {
  const cliStore = getStore()
  if (!cliStore) return []
  await prepareCliTools()
  return cliStore.applyCatalogStatus(catalog)
}

function requireStore(): CliToolStore {
  const cliStore = getStore()
  if (!cliStore) throw new CliToolError('RUNTIME_MISSING', 'the CLI tool store is not available in this process')
  return cliStore
}

/** The installed tools as the management view shows them. */
export async function getCliToolsOverview(): Promise<CliToolsOverview> {
  const cliStore = getStore()
  const signature = await catalogSignatureMode()
  if (!cliStore) return { available: false, tools: [], signature, pendingCleanup: 0, deliveryFailures: [] }
  await prepareCliTools()
  const state = await cliStore.readState()
  const skills = await cliStore.describeToolSkills(state)
  return {
    available: true,
    tools: buildToolViews(state, cliStore.launchedDirs(), skills),
    signature,
    pendingCleanup: state.pendingCleanup?.length ?? 0,
    deliveryFailures: deliveryFailureViews(state),
  }
}

function deliveryFailureViews(state: CliToolState): CliDeliveryFailureView[] {
  return Object.entries(state.deliveryFailures ?? {}).map(([key, failure]) => {
    const at = key.lastIndexOf('@')
    return { id: key.slice(0, at), version: key.slice(at + 1), code: failure.code }
  })
}

/**
 * Pure projection of state; exported for tests. `launched` holds the store
 * directories this process gave launchers to: a version among them that is no
 * longer current may still run a command, so its removal waits.
 */
export function buildToolViews(
  state: CliToolState,
  launched: ReadonlySet<string> = new Set(),
  skills: Record<string, CliToolSkillSummary> = {},
): CliToolView[] {
  return Object.entries(state.tools).map(([id, tool]): CliToolView => {
    const block = toolBlock(tool)
    const current = tool.current ? tool.versions[tool.current] : undefined
    const versions: CliToolVersionView[] = Object.entries(tool.versions)
      .sort(([a], [b]) => (a === EXTERNAL_VERSION ? 1 : b === EXTERNAL_VERSION ? -1 : compareVersions(b, a)))
      .map(([version, record]) => ({
        version,
        source: record.source,
        current: tool.current === version,
        commands: record.commands.map(c => c.name),
        importedAt: record.importedAt,
        ...(record.minNode ? { minNode: record.minNode } : {}),
        ...(record.sideEffects ? { sideEffects: record.sideEffects } : {}),
        ...(record.auth ? { auth: record.auth } : {}),
        ...(record.withdrawn ? { withdrawn: true } : {}),
        inUse: tool.current !== version && !!record.dir && launched.has(record.dir),
        removable: tool.current !== version && record.source !== 'preset' && !(record.source === 'catalog' && tool.autoInstall),
        ...(record.external
          ? {
              external: {
                path: record.external.path,
                interpreter: record.external.interpreter,
                registeredAt: record.external.registeredAt,
                ...(record.external.changed ? { changed: record.external.changed } : {}),
              },
            }
          : {}),
      }))
    const named = current ?? Object.values(tool.versions).find(v => v.name)
    return {
      id,
      name: named?.name ?? id,
      ...(named?.description ? { description: named.description } : {}),
      current: tool.current,
      status: block ?? 'available',
      disabled: tool.disabled === true,
      revoked: tool.revoked,
      delisted: tool.delisted === true,
      ...(tool.catalogUpdate ? { catalogUpdate: tool.catalogUpdate } : {}),
      hasPreset: Object.values(tool.versions).some(v => v.source === 'preset'),
      adminManaged: tool.autoInstall === true,
      commands: current?.commands.map(c => c.name) ?? [],
      ...(skills[id] ? { skill: { ...skills[id] } } : {}),
      versions,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

export interface UserPackagePreview extends PackagePreview {
  existing: { current: string | null; currentSource: CliToolView['versions'][number]['source'] | null } | null
  sameVersion: 'identical' | 'conflict' | null
  clashes: Record<string, 'tool' | 'path' | null>
}

/**
 * Validate a user's package in staging and describe it, relative to what is
 * installed. Nothing is installed or executed.
 */
export async function previewUserPackage(archivePath: string): Promise<UserPackagePreview> {
  const cliStore = requireStore()
  await prepareCliTools()
  const preview = await cliStore.previewPackage(archivePath)
  const state = await cliStore.readState()
  const tool = state.tools[preview.id]
  const same = tool?.versions[preview.version]
  const clashes: Record<string, 'tool' | 'path' | null> = {}
  for (const name of preview.commands) {
    const usedByTool = Object.entries(state.tools).some(([id, other]) =>
      id !== preview.id && other.current && other.versions[other.current]?.commands.some(c => c.name === name))
    clashes[name] = usedByTool ? 'tool' : commandOnPath(name, process.env.PATH ?? '', process.platform) ? 'path' : null
  }
  return {
    ...preview,
    existing: tool
      ? { current: tool.current, currentSource: tool.current ? tool.versions[tool.current]?.source ?? null : null }
      : null,
    sameVersion: same ? (same.integrity === preview.integrity ? 'identical' : 'conflict') : null,
    clashes,
  }
}

/**
 * Import a user's package after they confirmed its preview. The archive must
 * still have the digest that was previewed. It becomes current only when
 * asked to or when the tool has no current version: an existing choice from
 * any source is kept.
 */
export async function importUserPackage(
  archivePath: string,
  request: { archiveSha256: string; makeCurrent: boolean },
): Promise<ImportResult> {
  const cliStore = requireStore()
  await prepareCliTools()
  return cliStore.importPackage(archivePath, {
    source: 'user-import',
    expectedArchiveSha256: request.archiveSha256,
    activate: request.makeCurrent,
  })
}

export async function setCliToolCurrent(id: string, version: string): Promise<void> {
  const cliStore = requireStore()
  await prepareCliTools()
  await cliStore.activateVersion(id, version)
}

export async function setCliToolDisabled(id: string, disabled: boolean): Promise<void> {
  const cliStore = requireStore()
  await prepareCliTools()
  await cliStore.setDisabled(id, disabled)
}

export async function removeCliToolVersion(id: string, version: string): Promise<{ deferred: boolean }> {
  const cliStore = requireStore()
  await prepareCliTools()
  return cliStore.removeVersion(id, version)
}

export async function removeCliTool(id: string): Promise<{ deferred: number }> {
  const cliStore = requireStore()
  await prepareCliTools()
  return cliStore.removeTool(id)
}

export async function recordCliDeliveryFailure(
  id: string,
  version: string,
  failure: { bundle: string; code: CliToolErrorCode },
): Promise<void> {
  const cliStore = requireStore()
  await prepareCliTools()
  await cliStore.recordDeliveryFailure(id, version, failure)
}

export async function registerExternalProgram(request: RegisterExternalOptions): Promise<{ id: string; current: string | null }> {
  const cliStore = requireStore()
  await prepareCliTools()
  return cliStore.registerExternal(request)
}

export async function reconfirmExternalProgram(id: string): Promise<void> {
  const cliStore = requireStore()
  await prepareCliTools()
  await cliStore.reconfirmExternal(id)
}

/**
 * Whether a bundled version may replace a tool's current version: when it has
 * none, when that also came from a preset, or when a newer build ships a
 * higher version of a tool the administrator delivers.
 */
export function shouldActivatePreset(stateBefore: CliToolState, toolId: string, version: string): boolean {
  const tool = stateBefore.tools[toolId]
  if (!tool?.current) return true
  const source = tool.versions[tool.current]?.source
  if (source === 'preset') return true
  return source === 'catalog' && tool.autoInstall === true && compareVersions(version, tool.current) > 0
}
