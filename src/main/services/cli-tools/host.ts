/**
 * The app's one CLI tool store, and how sessions and terminals get its tools.
 *
 * Bootstrap calls `initCliTools` with paths only; nothing touches the disk
 * until a session asks for its environment or the idle task prepares the
 * store. Every failure logs and degrades to "no tools": a broken tool store
 * must never stop a conversation or a terminal from starting.
 */

import { existsSync, promises as fsp } from 'fs'
import { delimiter, join } from 'path'
import {
  CliToolStore,
  EXTERNAL_VERSION,
  commandOnPath,
  compareVersions,
  toolBlock,
  type CatalogToolStatus,
  type CliExecutionEntry,
  type CliToolState,
  type ImportResult,
  type PackagePreview,
  type RegisterExternalOptions,
} from './store'
import { CliToolError, isCliToolError } from './errors'
import type { CliCredentialBinding } from './credentials'
import {
  TRUSTED_KEYS_FILE,
  assertCatalogSignature,
  guideSignatureAccepted,
  loadTrustStore,
  type CatalogSignature,
  type TrustMode,
} from './signature'
import type { CliToolView, CliToolsOverview, CliToolVersionView } from '../../../shared/types/cli-tools'

/** Launcher directory of the tool set an environment was given; also tells the agent where TOOLS.md is. */
export const CLI_TOOLS_BIN_ENV = 'HALO_CLI_TOOLS_BIN'

export interface CliToolsHostOptions {
  /** Store root, e.g. `<userData>/cli`. */
  root: string
  /** Executable launched as Node. */
  runtimePath: string
  /** Directory of `.hcli` packages shipped with the build; null when the build has none. */
  presetDir: string | null
  /** Tools whose process receives a host-held credential; supplied by the caller, never read here. */
  credentialBindings?: CliCredentialBinding[]
}

type Env = Record<string, string | number | undefined>

let options: CliToolsHostOptions | null = null
let store: CliToolStore | null = null
let prepared: Promise<void> | null = null
/** Owner of this process's pins; a later process releases them. */
const holder = `p${process.pid}-${Date.now().toString(36)}`

/**
 * How long a session pin must stay unheld before it is released. It covers an
 * environment assembled for a session that has not started (and so taken its
 * hold) yet; a running session is covered by its hold (`holdCliTools`).
 */
export const CLI_TOOLS_IDLE_GRACE_MS = 10 * 60_000

/** Pins this process took for sessions, by execution id; `idleSince` is when a sweep first saw it unused. */
const sessionPins = new Map<string, { binDir: string; idleSince: number | null }>()
/** Launcher directories of running sessions, with how many hold each (see `holdCliTools`). */
const heldDirs = new Map<string, number>()
let sweepTimer: ReturnType<typeof setTimeout> | null = null
/** Pinning and releasing run one at a time, so a release never drops a lock a concurrent pin just reused. */
let pinOrder: Promise<unknown> = Promise.resolve()

function withPinOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = pinOrder.then(task, task)
  pinOrder = run.catch(() => undefined)
  return run
}

export function initCliTools(hostOptions: CliToolsHostOptions): void {
  options = hostOptions
}

function getStore(): CliToolStore | null {
  if (!options) return null
  store ??= new CliToolStore({
    root: options.root,
    runtimePath: options.runtimePath,
    runtimeNodeVersion: process.versions.node,
    credentialBindings: options.credentialBindings,
  })
  return store
}

/**
 * Clear locks left by an earlier app process, drop views nothing uses, and
 * import the packages shipped with this build. Runs once; the idle task
 * starts it and the first session waits for it.
 */
export function prepareCliTools(): Promise<void> {
  if (!prepared) prepared = runPrepare()
  return prepared
}

async function runPrepare(): Promise<void> {
  const cliStore = getStore()
  if (!cliStore || !options) return
  try {
    // A previous process's sessions are gone, so its pins protect nothing now.
    await cliStore.releaseOtherHolders(holder)
    await cliStore.pruneViews()
    // Versions removed while an earlier process still ran them.
    await cliStore.collectPendingCleanup()
    if (options.presetDir) await importPresets(cliStore, options.presetDir, options.root)
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
 * Import every `.hcli` in the build's preset directory. A preset becomes
 * current only when the tool has no current version or its current version
 * also came from a preset: a version the user or a catalog chose is kept.
 * An unchanged preset directory is skipped by its stamp, so later launches
 * re-hash nothing.
 */
async function importPresets(cliStore: CliToolStore, presetDir: string, root: string): Promise<void> {
  if (!existsSync(presetDir)) return
  const names = (await fsp.readdir(presetDir)).filter(name => name.endsWith('.hcli')).sort()
  const files: PresetStamp['files'] = []
  for (const name of names) {
    const stat = await fsp.stat(join(presetDir, name))
    files.push({ name, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) })
  }
  const stampFile = join(root, 'preset-stamp.json')
  const stamp = JSON.stringify({ files } satisfies PresetStamp)
  const previous = await fsp.readFile(stampFile, 'utf-8').catch(() => '')
  if (previous === stamp) return
  if (files.length === 0) return

  let failures = 0
  for (const name of names) {
    try {
      const state = await cliStore.readState()
      const result = await cliStore.importPackage(join(presetDir, name), {
        source: 'preset',
        activate: false,
      })
      const tool = (await cliStore.readState()).tools[result.id]
      if (shouldActivatePreset(state, result.id) && tool && tool.current !== result.version) {
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

/** What an administrator catalog promises about one package version. */
export interface CatalogPackageExpectation {
  id: string
  version: string
  /** sha256 hex of the archive. */
  archiveSha256: string
  /** Payload integrity, `sha256-<base64>`. */
  integrity: string
  /** The catalog's signature for this version; required when the build ships trusted keys. */
  signature?: CatalogSignature | null
}

function trustFile(): string | null {
  return options?.presetDir ? join(options.presetDir, TRUSTED_KEYS_FILE) : null
}

/** Whether catalog signatures are checked on this build (see signature.ts). */
export async function catalogSignatureMode(): Promise<TrustMode> {
  return (await loadTrustStore(trustFile())).mode
}

/**
 * Enforce the signature policy for one catalog version; throws
 * SIGNATURE_MISSING / SIGNATURE_INVALID. Callers may run it before
 * downloading; `installCatalogPackage` runs it again regardless.
 */
export async function verifyCatalogSignature(expected: CatalogPackageExpectation): Promise<void> {
  const trust = await loadTrustStore(trustFile())
  assertCatalogSignature(trust, expected, expected.signature ?? null)
}

/** Installed tools once the store is prepared; null when the host has no store. */
export async function readCliToolState(): Promise<CliToolState | null> {
  const cliStore = getStore()
  if (!cliStore) return null
  await prepareCliTools()
  return cliStore.readState()
}

/**
 * Import a package fetched from an administrator catalog and make it current.
 * The archive digest, payload integrity, id and version must all match what
 * the catalog promised; any difference leaves the installed versions as they
 * were. Executions already running keep their pinned versions.
 */
export async function installCatalogPackage(
  archivePath: string,
  expected: CatalogPackageExpectation,
): Promise<ImportResult> {
  const cliStore = getStore()
  if (!cliStore) throw new CliToolError('RUNTIME_MISSING', 'the CLI tool store is not available in this process')
  await prepareCliTools()
  await verifyCatalogSignature(expected)
  return cliStore.importPackage(archivePath, {
    source: 'catalog',
    expectedArchiveSha256: expected.archiveSha256,
    expectedIntegrity: expected.integrity,
    expectedTool: { id: expected.id, version: expected.version },
    activate: true,
  })
}

/**
 * Apply an administrator catalog's revocation flags to the installed tools it
 * lists, whatever their source; tools the catalog does not list are left
 * alone. Revocation keeps a tool out of new executions only; running ones
 * keep their launchers. Returns the ids whose flag changed.
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
  return cliStore.applyCatalogStatus(await withAcceptedGuides(catalog))
}

/**
 * Drop guide overrides whose signature the build does not accept, under the
 * same policy as packages (see signature.ts). A dropped version is left as it
 * is on this device rather than reverted to the package guide.
 */
async function withAcceptedGuides(catalog: CatalogToolStatus[]): Promise<CatalogToolStatus[]> {
  const hasOverride = catalog.some(tool => Object.values(tool.guides ?? {}).some(guide => guide.override))
  if (!hasOverride) return catalog
  const trust = await loadTrustStore(trustFile())
  return catalog.map(tool => {
    if (!tool.guides) return tool
    const guides: NonNullable<CatalogToolStatus['guides']> = {}
    for (const [version, guide] of Object.entries(tool.guides)) {
      const override = guide.override
      if (override) {
        const fields = { id: tool.id, version, revision: override.revision, sha256: override.sha256 }
        if (!guideSignatureAccepted(trust, fields, override.signature)) {
          console.warn('[CliTools] Guide override ignored: signature not accepted', {
            tool: `${tool.id}@${version}`, revision: override.revision, trust: trust.mode,
          })
          continue
        }
      }
      guides[version] = guide
    }
    return { ...tool, guides }
  })
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
  if (!cliStore) return { available: false, tools: [], signature, pendingCleanup: 0 }
  await prepareCliTools()
  const state = await cliStore.readState()
  const locks = await cliStore.listExecutionLocks()
  return { available: true, tools: buildToolViews(state, locks), signature, pendingCleanup: state.pendingCleanup?.length ?? 0 }
}

/** Pure projection of state + locks; exported for tests. */
export function buildToolViews(
  state: CliToolState,
  locks: Array<{ tools: Array<{ id: string; version: string }> }>,
): CliToolView[] {
  const pinned = new Set(locks.flatMap(lock => lock.tools.map(t => `${t.id}@${t.version}`)))
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
        inUse: pinned.has(`${id}@${version}`),
        removable: tool.current !== version && record.source !== 'preset',
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
      commands: current?.commands.map(c => c.name) ?? [],
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

/** Whether a bundled version may replace a tool's current version. */
export function shouldActivatePreset(stateBefore: CliToolState, toolId: string): boolean {
  const tool = stateBefore.tools[toolId]
  if (!tool?.current) return true
  return tool.versions[tool.current]?.source === 'preset'
}

/** PATH as a child would get it; Windows names are case-insensitive (see child-env). */
function readEnvPath(env: Env): string | undefined {
  const key = process.platform === 'win32'
    ? Object.keys(env).filter(name => name.toUpperCase() === 'PATH').sort()[0]
    : 'PATH'
  const value = key ? env[key] : undefined
  return typeof value === 'string' ? value : undefined
}

function writeEnvPath(env: Env, value: string): void {
  if (process.platform === 'win32') {
    for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name]
    env.Path = value
  } else {
    env.PATH = value
  }
}

/**
 * Give an environment the tool set current right now: append its launcher
 * directory to PATH and name it in `HALO_CLI_TOOLS_BIN`. Appending means a
 * launcher never shadows a command the user already has, and a name that is
 * taken is exposed as `halo-<name>`. Returns the directory, or null when no
 * tool is usable (the environment is then left without either change).
 *
 * The directory is content-addressed: a session built with it keeps those
 * exact versions, and an environment assembled after an update gets a new
 * directory.
 */
export async function applyCliToolsEnv(
  env: Env,
  request: { entry: CliExecutionEntry; engine: string }
): Promise<string | null> {
  delete env[CLI_TOOLS_BIN_ENV]
  const cliStore = getStore()
  if (!cliStore) return null
  try {
    await prepareCliTools()
    const basePath = readEnvPath(env)
    const pin = await withPinOrder(async () => {
      const taken = await cliStore.pinCurrent({ holder, entry: request.entry, engine: request.engine, basePath })
      // Terminals keep their tools until the app exits; every other pin is released by `releaseIdleCliTools`.
      if (taken?.binDir && request.entry !== 'terminal') {
        sessionPins.set(taken.lock.executionId, { binDir: taken.binDir, idleSince: null })
      }
      return taken
    })
    if (!pin?.binDir) return null
    writeEnvPath(env, basePath ? `${basePath}${delimiter}${pin.binDir}` : pin.binDir)
    env[CLI_TOOLS_BIN_ENV] = pin.binDir
    return pin.binDir
  } catch (err) {
    console.error('[CliTools] Tools not added to this environment', {
      entry: request.entry,
      engine: request.engine,
      code: isCliToolError(err) ? err.code : 'UNEXPECTED',
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Mark a session's launcher directory (its `HALO_CLI_TOOLS_BIN`) as in use
 * until the returned function is called, which the caller does once the
 * session's processes have exited. Calling it again is harmless. When the
 * last hold on a directory ends, a sweep (`releaseIdleCliTools`) is
 * scheduled. A missing directory is a no-op.
 */
export function holdCliTools(binDir: string | undefined): () => void {
  if (!binDir) return () => undefined
  heldDirs.set(binDir, (heldDirs.get(binDir) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (heldDirs.get(binDir) ?? 1) - 1
    if (left > 0) {
      heldDirs.set(binDir, left)
      return
    }
    heldDirs.delete(binDir)
    scheduleSweep(1000)
  }
}

function scheduleSweep(delayMs: number): void {
  if (sweepTimer || sessionPins.size === 0) return
  sweepTimer = setTimeout(() => {
    sweepTimer = null
    void releaseIdleCliTools().then(({ waiting }) => {
      if (waiting > 0) scheduleSweep(CLI_TOOLS_IDLE_GRACE_MS)
    })
  }, delayMs)
  sweepTimer.unref?.()
}

/**
 * Release the session pins no running session holds, then delete the removed
 * versions and views nothing pins any more. A pin is released only when it
 * was already unheld at an earlier sweep at least `CLI_TOOLS_IDLE_GRACE_MS`
 * ago, so an environment assembled for a session that has not started yet
 * keeps its files. Returns how many unheld pins are still waiting for their
 * grace period. Never throws.
 */
export async function releaseIdleCliTools(
  now: number = Date.now()
): Promise<{ released: number; waiting: number }> {
  const cliStore = getStore()
  if (!cliStore || sessionPins.size === 0) return { released: 0, waiting: 0 }
  try {
    return await withPinOrder(async () => {
      let released = 0
      let waiting = 0
      for (const [executionId, pin] of [...sessionPins]) {
        if (heldDirs.has(pin.binDir)) {
          pin.idleSince = null
        } else if (pin.idleSince === null || now - pin.idleSince < CLI_TOOLS_IDLE_GRACE_MS) {
          pin.idleSince ??= now
          waiting += 1
        } else {
          await cliStore.releaseExecution(executionId)
          sessionPins.delete(executionId)
          released += 1
        }
      }
      if (released > 0) {
        await cliStore.collectPendingCleanup()
        await cliStore.pruneViews()
      }
      return { released, waiting }
    })
  } catch (err) {
    console.error('[CliTools] Releasing unused tool pins failed; they stay until the app restarts', {
      code: isCliToolError(err) ? err.code : 'UNEXPECTED',
      message: err instanceof Error ? err.message : String(err),
    })
    return { released: 0, waiting: 0 }
  }
}
