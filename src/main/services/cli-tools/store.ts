/**
 * The CLI tool store: installed versions, the current choice per tool, and the
 * pinned command views running executions use. See DESIGN.md.
 *
 * Layout under `root` (the caller passes e.g. `<userData>/cli`):
 *
 *   store/<id>/<version>-<digest12>/   immutable, read-only installed package
 *   staging/<txid>/                    one import transaction; removed on exit
 *   views/<viewKey>/bin/               launchers for one exact tool set
 *   views/<viewKey>/TOOLS.md           what those launchers are, for the agent
 *   views/<viewKey>/argv-preload.cjs   argv fix the launchers load (see shims.ts)
 *   locks/<executionId>.json           the tool set an execution is pinned to
 *   state.json                         versions, current choice, revocation
 *
 * The module is pure Node and takes every environment fact as a parameter
 * (root, runtime path, runtime version, platform), so it imports no Electron
 * or agent code and starts no work on its own.
 */

import { createHash, randomUUID } from 'crypto'
import { existsSync, promises as fsp } from 'fs'
import { isAbsolute, join } from 'path'
import { extractPackageArchive, DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from './archive'
import { CliToolError, isCliToolError } from './errors'
import { assertManifestSupported, parseCliManifest, type CliManifest } from './manifest'
import { inspectPayload, integrityOf, integrityShortHex, scanPayload } from './payload'
import { ARGV_PRELOAD_FILE, launcherFiles, renderArgvPreload } from './shims'

export type CliToolSource = 'preset' | 'catalog' | 'user-import'

/** Which surface started an execution; recorded for diagnosis only. */
export type CliExecutionEntry = 'chat' | 'app-chat' | 'im' | 'automation' | 'team' | 'terminal' | 'other'

export interface CliToolVersionRecord {
  /** Payload integrity, `sha256-<base64>`; the content address. */
  integrity: string
  /** sha256 hex of the imported archive. */
  archiveSha256: string
  /** Store directory relative to `root`, `/`-separated. */
  dir: string
  source: CliToolSource
  importedAt: string
  commands: Array<{ name: string; entry: string }>
  minNode?: string
  guide?: string
  sideEffects?: CliManifest['sideEffects']
  auth?: NonNullable<CliManifest['auth']>['method']
}

export interface CliToolRecord {
  current: string | null
  revoked: boolean
  versions: Record<string, CliToolVersionRecord>
}

export interface CliToolState {
  schema: 1
  tools: Record<string, CliToolRecord>
}

export interface CliToolStoreOptions {
  /** Directory the store owns exclusively. */
  root: string
  /** Executable launched as Node (the headless Electron binary). */
  runtimePath: string
  /** Node version of that runtime (`process.versions.node` under Electron). */
  runtimeNodeVersion: string
  platform?: NodeJS.Platform
  arch?: string
  archiveLimits?: ArchiveLimits
  /** Logger; defaults to console. Messages never contain credentials or file contents. */
  log?: Pick<Console, 'log' | 'error'>
}

export interface ImportOptions {
  source: CliToolSource
  /** Expected archive sha256 hex (e.g. from a catalog); mismatch is DIGEST_MISMATCH. */
  expectedArchiveSha256?: string
  /** Expected payload integrity (e.g. from a catalog); mismatch is DIGEST_MISMATCH. */
  expectedIntegrity?: string
  /** Tool id and version the package must declare (e.g. the catalog entry it was fetched for). */
  expectedTool?: { id: string; version: string }
  /** Make the imported version current (default true). */
  activate?: boolean
}

export interface ImportResult {
  id: string
  version: string
  integrity: string
  /** False when the identical content was already installed. */
  installed: boolean
  current: string | null
  previous: string | null
}

export interface ExposedCommand {
  toolId: string
  version: string
  command: string
  /** Name on PATH; `halo-<command>` when the plain name is already taken. */
  exposedAs: string
  conflict: boolean
}

export interface CliExecutionLock {
  schema: 1
  executionId: string
  entry: CliExecutionEntry
  engine: string
  /** Process that owns a pin taken with `pinCurrent`; absent for `pinExecution`. */
  holder?: string
  viewKey: string
  runtimeNodeVersion: string
  tools: Array<{ id: string; version: string; integrity: string; guide?: string }>
  commands: ExposedCommand[]
  createdAt: string
}

export interface PinExecutionOptions {
  executionId: string
  entry: CliExecutionEntry
  engine: string
  /**
   * PATH the execution would otherwise see. A command name already resolvable
   * there is exposed as `halo-<name>` instead, so the user's own tool keeps
   * its name. Omit to skip the check.
   */
  basePath?: string
}

export interface PinCurrentOptions {
  /**
   * Owner of the pin, e.g. one app process. Every caller with the same holder
   * and the same current tool set shares one lock; `releaseOtherHolders`
   * clears the locks of holders that are gone.
   */
  holder: string
  entry: CliExecutionEntry
  engine: string
  basePath?: string
}

export interface PinnedExecution {
  /** Directory to append to the execution's PATH. Null when no tool is usable. */
  binDir: string | null
  lock: CliExecutionLock
  /** True when an existing pin was returned unchanged. */
  reused: boolean
}

const STATE_MAX_BYTES = 1024 * 1024
const MAX_PATH_ENTRIES = 256
const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function lockFileName(executionId: string): string {
  // Ids that are not file-name safe are stored under their hash; the lock keeps the original.
  return EXECUTION_ID_PATTERN.test(executionId) ? `${executionId}.json` : `x-${sha256(executionId).slice(0, 32)}.json`
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}`
  try {
    await fsp.writeFile(tmp, content, 'utf-8')
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** Mark an installed tree read-only (files 0444, dirs 0555 on POSIX; files only on Windows). */
async function setTreeReadOnly(dir: string, readOnly: boolean, platform: NodeJS.Platform): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  if (!readOnly && platform !== 'win32') await fsp.chmod(dir, 0o755)
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await setTreeReadOnly(path, readOnly, platform)
    } else if (entry.isFile()) {
      await fsp.chmod(path, readOnly ? 0o444 : 0o644)
    }
  }
  if (readOnly && platform !== 'win32') await fsp.chmod(dir, 0o555)
}

/** Whether `name` resolves through `pathValue` (Windows: with PATHEXT extensions). */
export function commandOnPath(
  name: string,
  pathValue: string,
  platform: NodeJS.Platform,
  ignoreDirs: string[] = []
): boolean {
  const delimiter = platform === 'win32' ? ';' : ':'
  const extensions = platform === 'win32' ? ['', '.com', '.exe', '.bat', '.cmd'] : ['']
  const dirs = pathValue.split(delimiter).filter(Boolean).slice(0, MAX_PATH_ENTRIES)
  for (const dir of dirs) {
    if (!isAbsolute(dir) || ignoreDirs.some(ignored => dir.startsWith(ignored))) continue
    for (const ext of extensions) {
      if (existsSync(join(dir, name + ext))) return true
    }
  }
  return false
}

export class CliToolStore {
  private readonly root: string
  private readonly runtimePath: string
  private readonly runtimeNodeVersion: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly limits: ArchiveLimits
  private readonly log: Pick<Console, 'log' | 'error'>
  /** Serializes every mutation in this process; Halo runs as a single instance. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: CliToolStoreOptions) {
    if (!isAbsolute(options.root)) throw new Error('cli-tools root must be absolute')
    this.root = options.root
    this.runtimePath = options.runtimePath
    this.runtimeNodeVersion = options.runtimeNodeVersion
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.limits = options.archiveLimits ?? DEFAULT_ARCHIVE_LIMITS
    this.log = options.log ?? console
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts)
  }

  // ── state ────────────────────────────────────────────────────────────

  /** Read state.json; a missing file is an empty store, an unreadable one is STATE_CORRUPT. */
  async readState(): Promise<CliToolState> {
    const file = this.path('state.json')
    let text: string
    try {
      const stat = await fsp.stat(file)
      if (stat.size > STATE_MAX_BYTES) throw new CliToolError('STATE_CORRUPT', 'state.json exceeds its size limit')
      text = await fsp.readFile(file, 'utf-8')
    } catch (err) {
      if (isCliToolError(err)) throw err
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, tools: {} }
      throw err
    }
    try {
      const state = JSON.parse(text) as CliToolState
      if (state?.schema !== 1 || typeof state.tools !== 'object' || state.tools === null) throw new Error('shape')
      return state
    } catch {
      this.log.error('[CliTools] state.json is unreadable; refusing to reset it')
      throw new CliToolError('STATE_CORRUPT', 'state.json cannot be parsed')
    }
  }

  private async writeState(state: CliToolState): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true })
    await writeFileAtomic(this.path('state.json'), `${JSON.stringify(state, null, 2)}\n`)
  }

  // ── import ───────────────────────────────────────────────────────────

  /**
   * Import a `.hcli` archive as one transaction: extract into a private
   * staging directory, validate manifest, host support, paths, the pure-JS
   * rule and integrity, then publish with a single rename and record it in
   * state.json. Any failure removes the staging directory and leaves the
   * previous state and every installed version untouched.
   */
  importPackage(archivePath: string, options: ImportOptions): Promise<ImportResult> {
    return this.serialize(() => this.importLocked(archivePath, options))
  }

  private async importLocked(archivePath: string, options: ImportOptions): Promise<ImportResult> {
    const started = Date.now()
    const txid = randomUUID()
    const stagingRoot = this.path('staging')
    const staging = join(stagingRoot, txid)
    let stage = 'prepare'
    let published: string | null = null
    let label = '(unknown)'
    try {
      // No other import runs in this process, so anything left here is from a crash.
      await fsp.rm(stagingRoot, { recursive: true, force: true })
      await fsp.mkdir(staging, { recursive: true })

      stage = 'extract'
      const archive = await extractPackageArchive(archivePath, staging, this.limits)
      if (options.expectedArchiveSha256 && options.expectedArchiveSha256.toLowerCase() !== archive.archiveSha256) {
        throw new CliToolError('DIGEST_MISMATCH', 'package archive digest differs from the expected digest')
      }

      stage = 'manifest'
      const manifest = parseCliManifest(await fsp.readFile(join(staging, 'manifest.json'), 'utf-8'))
      label = `${manifest.id}@${manifest.version}`
      const expected = options.expectedTool
      if (expected && (expected.id !== manifest.id || expected.version !== manifest.version)) {
        throw new CliToolError('PACKAGE_INVALID', `package declares ${label}, expected ${expected.id}@${expected.version}`)
      }
      assertManifestSupported(manifest, {
        platform: this.platform,
        arch: this.arch,
        nodeVersion: this.runtimeNodeVersion,
      })

      stage = 'payload'
      const payloadDir = join(staging, 'payload')
      if (!existsSync(payloadDir)) throw new CliToolError('PACKAGE_INVALID', 'package has no payload directory')
      const inspection = await inspectPayload(payloadDir)
      if (inspection.integrity !== manifest.integrity) {
        throw new CliToolError('DIGEST_MISMATCH', 'payload content differs from the manifest integrity')
      }
      if (options.expectedIntegrity && options.expectedIntegrity !== inspection.integrity) {
        throw new CliToolError('DIGEST_MISMATCH', 'payload content differs from the expected integrity')
      }
      for (const command of manifest.commands) {
        const stat = await fsp.lstat(join(payloadDir, command.entry)).catch(() => null)
        if (!stat?.isFile()) {
          throw new CliToolError('MANIFEST_INVALID', `entry of command "${command.name}" is not a packaged file`)
        }
      }
      if (manifest.guide) {
        const stat = await fsp.lstat(join(staging, manifest.guide)).catch(() => null)
        if (!stat?.isFile()) throw new CliToolError('MANIFEST_INVALID', 'guide is not a packaged file')
      }

      stage = 'publish'
      const state = await this.readState()
      const tool: CliToolRecord = state.tools[manifest.id] ?? { current: null, revoked: false, versions: {} }
      const existing = tool.versions[manifest.version]
      const activate = options.activate !== false
      if (existing) {
        if (existing.integrity !== inspection.integrity) {
          throw new CliToolError(
            'VERSION_CONFLICT',
            `${label} is already installed with different content; publish a new version instead`
          )
        }
        await fsp.rm(staging, { recursive: true, force: true })
        const previous = tool.current
        if (activate && tool.current !== manifest.version) {
          tool.current = manifest.version
          state.tools[manifest.id] = tool
          await this.writeState(state)
        }
        this.log.log('[CliTools] Import matched an installed version', { tool: label, current: tool.current })
        return {
          id: manifest.id, version: manifest.version, integrity: inspection.integrity,
          installed: false, current: tool.current, previous,
        }
      }

      const dirRel = `store/${manifest.id}/${manifest.version}-${integrityShortHex(inspection.integrity)}`
      const target = this.path(...dirRel.split('/'))
      await fsp.mkdir(this.path('store', manifest.id), { recursive: true })
      // A directory left by a publish whose state write failed holds the same
      // content (same address); replace it rather than trusting it.
      if (existsSync(target)) {
        await setTreeReadOnly(target, false, this.platform)
        await fsp.rm(target, { recursive: true, force: true })
      }
      // Rename before locking: moving a directory to a new parent rewrites its
      // `..` entry, which POSIX refuses on a read-only directory. Nothing refers
      // to the target until state.json is written below.
      await fsp.rename(staging, target)
      published = target
      await setTreeReadOnly(target, true, this.platform)

      const previous = tool.current
      tool.versions[manifest.version] = {
        integrity: inspection.integrity,
        archiveSha256: archive.archiveSha256,
        dir: dirRel,
        source: options.source,
        importedAt: new Date().toISOString(),
        commands: manifest.commands.map(c => ({ name: c.name, entry: c.entry })),
        ...(manifest.runtime.minNode ? { minNode: manifest.runtime.minNode } : {}),
        ...(manifest.guide ? { guide: manifest.guide } : {}),
        ...(manifest.sideEffects ? { sideEffects: manifest.sideEffects } : {}),
        ...(manifest.auth ? { auth: manifest.auth.method } : {}),
      }
      if (activate || tool.current === null) tool.current = manifest.version
      state.tools[manifest.id] = tool
      stage = 'state'
      await this.writeState(state)
      published = null

      this.log.log('[CliTools] Imported package', {
        tool: label,
        source: options.source,
        files: inspection.files,
        bytes: inspection.bytes,
        current: tool.current,
        ms: Date.now() - started,
      })
      return {
        id: manifest.id, version: manifest.version, integrity: inspection.integrity,
        installed: true, current: tool.current, previous,
      }
    } catch (err) {
      if (published) {
        // State was not updated, so nothing references the new directory.
        await setTreeReadOnly(published, false, this.platform).catch(() => undefined)
        await fsp.rm(published, { recursive: true, force: true }).catch(() => undefined)
      }
      if (existsSync(staging)) {
        await setTreeReadOnly(staging, false, this.platform).catch(() => undefined)
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
      this.log.error('[CliTools] Import failed; installed versions unchanged', {
        tool: label,
        stage,
        code: isCliToolError(err) ? err.code : 'UNEXPECTED',
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  // ── current version, revocation, removal ─────────────────────────────

  /** Make an installed version current (upgrade or rollback). Running pins are unaffected. */
  activateVersion(id: string, version: string): Promise<{ current: string; previous: string | null }> {
    return this.serialize(async () => {
      const state = await this.readState()
      const tool = state.tools[id]
      if (!tool?.versions[version]) throw new CliToolError('NOT_FOUND', `${id}@${version} is not installed`)
      const previous = tool.current
      tool.current = version
      await this.writeState(state)
      this.log.log('[CliTools] Current version changed', { tool: id, from: previous, to: version })
      return { current: version, previous }
    })
  }

  /** Exclude (or re-admit) a tool for new executions. Existing pins keep their launchers. */
  setRevoked(id: string, revoked: boolean): Promise<void> {
    return this.serialize(async () => {
      const state = await this.readState()
      const tool = state.tools[id]
      if (!tool) throw new CliToolError('NOT_FOUND', `${id} is not installed`)
      tool.revoked = revoked
      await this.writeState(state)
      this.log.log('[CliTools] Revocation changed', { tool: id, revoked })
    })
  }

  /**
   * Delete an installed version. Refused (IN_USE) while it is current or any
   * execution lock pins it, so a running task never loses its files.
   */
  removeVersion(id: string, version: string): Promise<void> {
    return this.serialize(async () => {
      const state = await this.readState()
      const tool = state.tools[id]
      const record = tool?.versions[version]
      if (!tool || !record) throw new CliToolError('NOT_FOUND', `${id}@${version} is not installed`)
      if (tool.current === version) {
        throw new CliToolError('IN_USE', `${id}@${version} is the current version`)
      }
      const pinnedBy = (await this.listExecutionLocks()).filter(lock =>
        lock.tools.some(t => t.id === id && t.version === version))
      if (pinnedBy.length > 0) {
        throw new CliToolError('IN_USE', `${id}@${version} is pinned by ${pinnedBy.length} running execution(s)`)
      }
      delete tool.versions[version]
      if (Object.keys(tool.versions).length === 0) delete state.tools[id]
      // State first: a crash after this leaves an orphan directory, never a
      // state entry pointing at deleted files.
      await this.writeState(state)
      const dir = this.path(...record.dir.split('/'))
      if (existsSync(dir)) {
        await setTreeReadOnly(dir, false, this.platform)
        await fsp.rm(dir, { recursive: true, force: true })
      }
      this.log.log('[CliTools] Removed version', { tool: `${id}@${version}` })
    })
  }

  /** Re-hash an installed version and compare it with its recorded integrity. */
  async verifyVersion(id: string, version: string): Promise<boolean> {
    const record = (await this.readState()).tools[id]?.versions[version]
    if (!record) throw new CliToolError('NOT_FOUND', `${id}@${version} is not installed`)
    const files = await scanPayload(this.path(...record.dir.split('/'), 'payload'), false)
    const ok = integrityOf(files) === record.integrity
    if (!ok) this.log.error('[CliTools] Installed version no longer matches its integrity', { tool: `${id}@${version}` })
    return ok
  }

  // ── executions ───────────────────────────────────────────────────────

  /**
   * Pin an execution to the current tool set and return the launcher
   * directory for its PATH. Calling again with the same execution id returns
   * the original pin, so a running task keeps the versions it started with
   * while the next execution picks up whatever is current then.
   */
  pinExecution(options: PinExecutionOptions): Promise<PinnedExecution> {
    return this.serialize(() => this.pinLocked(options))
  }

  private async pinLocked(options: PinExecutionOptions): Promise<PinnedExecution> {
    const existing = await this.readExecutionLock(options.executionId)
    const state = await this.readState()
    if (existing) {
      const binDir = existing.commands.length > 0 ? await this.ensureView(existing, state) : null
      return { binDir, lock: existing, reused: true }
    }
    const lock = this.composeLock(options, state)
    const binDir = lock.commands.length > 0 ? await this.ensureView(lock, state) : null
    await this.writeLock(lock)
    return { binDir, lock, reused: false }
  }

  /**
   * Pin the tool set that is current right now on behalf of `holder`. The
   * same holder and tool set map to one lock (`<holder>-<viewKey>`), so a
   * caller that assembles an environment per request can call this every
   * time: it gets the current set, and a set it used earlier stays pinned
   * until the holder's locks are released. Nothing is written when no tool
   * is usable.
   */
  pinCurrent(options: PinCurrentOptions): Promise<PinnedExecution | null> {
    return this.serialize(async () => {
      const state = await this.readState()
      if (!Object.values(state.tools).some(tool => tool.current && !tool.revoked)) return null
      const draft = this.composeLock({ ...options, executionId: options.holder }, state)
      if (draft.commands.length === 0) return null
      const executionId = `${options.holder}-${draft.viewKey}`
      const existing = await this.readExecutionLock(executionId)
      if (existing && existing.viewKey === draft.viewKey) {
        return { binDir: await this.ensureView(existing, state), lock: existing, reused: true }
      }
      const lock: CliExecutionLock = { ...draft, executionId, holder: options.holder }
      const binDir = await this.ensureView(lock, state)
      await this.writeLock(lock)
      return { binDir, lock, reused: false }
    })
  }

  /** Release every lock not taken by `holder`, e.g. those of a previous app process. */
  releaseOtherHolders(holder: string): Promise<number> {
    return this.serialize(async () => {
      let names: string[]
      try {
        names = await fsp.readdir(this.path('locks'))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw err
      }
      let released = 0
      for (const name of names.filter(n => n.endsWith('.json'))) {
        const file = this.path('locks', name)
        let owner: string | undefined
        try {
          owner = (JSON.parse(await fsp.readFile(file, 'utf-8')) as CliExecutionLock).holder
        } catch {
          owner = undefined
        }
        if (owner === holder) continue
        await fsp.rm(file, { force: true })
        released += 1
      }
      if (released > 0) this.log.log('[CliTools] Released locks of earlier holders', { released })
      return released
    })
  }

  private async writeLock(lock: CliExecutionLock): Promise<void> {
    await fsp.mkdir(this.path('locks'), { recursive: true })
    await writeFileAtomic(this.path('locks', lockFileName(lock.executionId)), `${JSON.stringify(lock, null, 2)}\n`)
  }

  private composeLock(options: PinExecutionOptions, state: CliToolState): CliExecutionLock {
    if (!existsSync(this.runtimePath)) {
      this.log.error('[CliTools] Runtime executable is missing; no tools exposed', {
        execution: options.executionId,
      })
      throw new CliToolError('RUNTIME_MISSING', 'the runtime executable does not exist')
    }

    const tools: CliExecutionLock['tools'] = []
    const commands: ExposedCommand[] = []
    const taken = new Set<string>()
    const viewsDir = this.path('views')
    for (const id of Object.keys(state.tools).sort()) {
      const tool = state.tools[id]
      if (tool.revoked || !tool.current) continue
      const record = tool.versions[tool.current]
      if (!record) continue
      tools.push({ id, version: tool.current, integrity: record.integrity, ...(record.guide ? { guide: record.guide } : {}) })
      for (const command of record.commands) {
        const conflict = taken.has(command.name) ||
          (options.basePath !== undefined && commandOnPath(command.name, options.basePath, this.platform, [viewsDir]))
        const exposedAs = conflict ? `halo-${command.name}` : command.name
        if (taken.has(exposedAs)) {
          this.log.error('[CliTools] Command not exposed: name and alias both taken', {
            tool: id, command: command.name,
          })
          continue
        }
        taken.add(exposedAs)
        commands.push({ toolId: id, version: tool.current, command: command.name, exposedAs, conflict })
      }
    }

    const lock: CliExecutionLock = {
      schema: 1,
      executionId: options.executionId,
      entry: options.entry,
      engine: options.engine,
      viewKey: '',
      runtimeNodeVersion: this.runtimeNodeVersion,
      tools,
      commands,
      createdAt: new Date().toISOString(),
    }
    lock.viewKey = this.viewKeyOf(lock, state)
    return lock
  }

  private launcherTargets(lock: CliExecutionLock, state: CliToolState): Array<{ exposedAs: string; entry: string }> {
    return lock.commands.map(command => {
      const record = state.tools[command.toolId]?.versions[command.version]
      if (!record) {
        throw new CliToolError('NOT_FOUND', `${command.toolId}@${command.version} pinned by an execution is missing`)
      }
      const entry = record.commands.find(c => c.name === command.command)?.entry
      if (!entry) throw new CliToolError('NOT_FOUND', `command "${command.command}" is missing`)
      return { exposedAs: command.exposedAs, entry: join(this.path(...record.dir.split('/')), 'payload', ...entry.split('/')) }
    })
  }

  private viewKeyOf(lock: CliExecutionLock, state: CliToolState): string {
    const targets = this.launcherTargets(lock, state)
    return sha256(JSON.stringify({ v: 3, platform: this.platform, runtime: this.runtimePath, targets })).slice(0, 20)
  }

  /**
   * Views are immutable and content-addressed: the same tool set shares one
   * directory, a different set gets a new one. Built in a temporary directory
   * and renamed into place, so a reader never sees a half-written view.
   */
  private async ensureView(lock: CliExecutionLock, state: CliToolState): Promise<string> {
    const viewDir = this.path('views', lock.viewKey)
    const binDir = join(viewDir, 'bin')
    if (existsSync(join(viewDir, 'view.json'))) return binDir

    const tmp = this.path('views', `.tmp-${randomUUID()}`)
    try {
      await fsp.mkdir(join(tmp, 'bin'), { recursive: true })
      // Launchers name the preload by its final path, where the view lands after the rename.
      await fsp.writeFile(join(tmp, ARGV_PRELOAD_FILE), renderArgvPreload(), 'utf-8')
      const preloadPath = join(viewDir, ARGV_PRELOAD_FILE)
      for (const target of this.launcherTargets(lock, state)) {
        const paths = { runtimePath: this.runtimePath, preloadPath, entryPath: target.entry }
        for (const file of launcherFiles(this.platform, target.exposedAs, paths)) {
          const path = join(tmp, 'bin', file.name)
          await fsp.writeFile(path, file.content, { encoding: 'utf-8', mode: file.executable ? 0o755 : 0o644 })
        }
      }
      await fsp.writeFile(join(tmp, 'TOOLS.md'), this.renderToolsGuide(lock, state), 'utf-8')
      await fsp.writeFile(join(tmp, 'view.json'), `${JSON.stringify({ viewKey: lock.viewKey, commands: lock.commands }, null, 2)}\n`)
      if (existsSync(viewDir)) await fsp.rm(viewDir, { recursive: true, force: true })
      await fsp.rename(tmp, viewDir)
      this.log.log('[CliTools] Command view created', { view: lock.viewKey, commands: lock.commands.length })
      return binDir
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      this.log.error('[CliTools] Command view could not be created', {
        view: lock.viewKey,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /**
   * The agent-facing index of a view: which commands it has, what they are,
   * and where each tool's guide is. A skill points the agent here.
   */
  private renderToolsGuide(lock: CliExecutionLock, state: CliToolState): string {
    const lines = [
      '# Command-line tools in this session',
      '',
      'Run these commands from the shell. Halo installed them and runs them on its bundled runtime;',
      'do not install, update or remove them yourself.',
      '',
      '| Command | Tool | Version | Side effects | Sign-in | Guide |',
      '|---|---|---|---|---|---|',
    ]
    for (const command of lock.commands) {
      const record = state.tools[command.toolId]?.versions[command.version]
      const guide = record?.guide ? join(this.path(...record.dir.split('/')), ...record.guide.split('/')) : ''
      lines.push(`| \`${command.exposedAs}\` | ${command.toolId} | ${command.version} | ${record?.sideEffects ?? 'unknown'} | ${record?.auth ?? 'unknown'} | ${guide ? `\`${guide}\`` : '-'} |`)
    }
    lines.push(
      '',
      'Read a tool\'s guide before its first use in a task.',
      'A command shown as `halo-<name>` has that prefix because another `<name>` already exists on this',
      'computer; plain `<name>` runs that other program, not this tool.',
      'If a tool that writes data fails with an unknown outcome, check the result before running it again.',
      '',
    )
    return lines.join('\n')
  }

  /** Release an execution's pin. Its versions become removable once no pin remains. */
  releaseExecution(executionId: string): Promise<boolean> {
    return this.serialize(async () => {
      try {
        await fsp.unlink(this.path('locks', lockFileName(executionId)))
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      }
    })
  }

  async readExecutionLock(executionId: string): Promise<CliExecutionLock | null> {
    try {
      const lock = JSON.parse(
        await fsp.readFile(this.path('locks', lockFileName(executionId)), 'utf-8')
      ) as CliExecutionLock
      return lock.executionId === executionId ? lock : null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      this.log.error('[CliTools] Execution lock unreadable; treating as absent', { execution: executionId })
      return null
    }
  }

  async listExecutionLocks(): Promise<CliExecutionLock[]> {
    let names: string[]
    try {
      names = await fsp.readdir(this.path('locks'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const locks: CliExecutionLock[] = []
    for (const name of names.filter(n => n.endsWith('.json'))) {
      try {
        locks.push(JSON.parse(await fsp.readFile(this.path('locks', name), 'utf-8')) as CliExecutionLock)
      } catch {
        // An unreadable lock still protects nothing we can name; report it once.
        this.log.error('[CliTools] Skipping unreadable execution lock', { file: name })
      }
    }
    return locks
  }

  /** Delete views no execution lock refers to. Returns the number removed. */
  pruneViews(): Promise<number> {
    return this.serialize(async () => {
      const referenced = new Set((await this.listExecutionLocks()).map(lock => lock.viewKey))
      let names: string[]
      try {
        names = await fsp.readdir(this.path('views'))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw err
      }
      let removed = 0
      for (const name of names) {
        if (referenced.has(name)) continue
        await fsp.rm(this.path('views', name), { recursive: true, force: true })
        removed += 1
      }
      if (removed > 0) this.log.log('[CliTools] Pruned unused command views', { removed })
      return removed
    })
  }
}
