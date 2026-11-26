/**
 * The CLI tool store: installed versions, the current choice per tool, and the
 * pinned command views running executions use. See DESIGN.md.
 *
 * Layout under `root` (the caller passes e.g. `<userData>/cli`):
 *
 *   store/<id>/<version>-<digest12>/   immutable, read-only installed package
 *   support/<id>/<version>-<digest12>/<supportDigest>/    immutable runtime variants
 *   staging/<txid>/                    one import transaction; removed on exit
 *   guides/<sha256>.md                 administrator guide overrides, by content
 *   views/<viewKey>/bin/               launchers for one exact tool set
 *   views/<viewKey>/TOOLS.md           what those launchers are, for the agent
 *   views/<viewKey>/guides/<id>.md     overrides that view was pinned to (copies)
 *   views/<viewKey>/view.json          the view's commands; written last
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
import { basename, dirname, isAbsolute, join } from 'path'
import { extractPackageArchive, DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from './archive'
import { CliToolError, isCliToolError, type CliToolErrorCode } from './errors'
import { assertManifestSupported, parseCliManifest, type CliManifest } from './manifest'
import { inspectPayload, integrityOf, integrityShortHex, scanPayload } from './payload'
import { Emitter } from '../../platform/event'
import { ARGV_PRELOAD_FILE, launcherFiles, renderArgvPreload } from './shims'
import {
  credentialPreloadFile,
  renderCredentialPreload,
  sourceMayBind,
  validateCredentialBinding,
  type CliCredentialBinding,
} from './credentials'
import type { CatalogSignature } from './signature'
import type { PresetCatalog } from './preset-catalog'
import {
  assertRealDirectories, assertSupportFiles, BASE_SUPPORT_FILE, copyPackageTree, loadSupportFiles,
  placeSupportFiles, renderSupportPreload, supportDigest, supportError, supportExpectations,
  supportPathExists, SUPPORT_FAILURE, type CliSupportFilesConfig, type SupportCheck,
} from './support-files'
import {
  cliSkillName,
  GUIDE_MAX_BYTES,
  renderCliSkill,
  resolveSkillDescription,
  splitGuide,
  type CliSkillSource,
  type CliToolSkill,
} from './skills'

/**
 * Where an installed version came from. `external` is a program already on the
 * computer that the user registered: Halo keeps only a record of it.
 */
export type CliToolSource = 'preset' | 'catalog' | 'user-import' | 'external'

function toolOrigin(source?: CliToolSource): 'organization' | 'user' {
  return source === 'preset' || source === 'catalog' ? 'organization' : 'user'
}

/** Version key of a registered existing program; a tool has at most one. */
export const EXTERNAL_VERSION = 'external'

/** A registered program Halo does not manage: never copied, changed or deleted. */
export interface CliExternalRecord {
  /** Absolute path of the executable or script. */
  path: string
  /** `halo-node` runs a .js/.mjs/.cjs script on the bundled runtime; null runs the file itself. */
  interpreter: 'halo-node' | null
  sha256: string
  size: number
  mtimeMs: number
  registeredAt: string
  /** Set when the file went missing or changed since it was confirmed; excluded from new executions. */
  changed?: 'missing' | 'modified'
}

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
  /** Display name and description from the manifest (or the registration). */
  name?: string
  description?: string
  /** A catalog version the catalog no longer lists. Informational: it stays usable. */
  withdrawn?: boolean
  /**
   * The administrator's replacement for the package guide (`guides/<sha256>.md`).
   * Only preset and catalog versions take one; the text is never kept in state.
   * `tool` marks a preset version's copy of the tool's skill rather than a
   * guide set for this version, so clearing the skill never drops the latter.
   */
  guideOverride?: { revision: number; sha256: string; tool?: true; bundled?: true }
  /** A live catalog has decided this preset's text, including resetting it to the package guide. */
  liveGuideSeen?: true
  /** Present only for `source: 'external'`; `dir` is then empty. */
  external?: CliExternalRecord
  /** Digest of the support files included when this immutable directory was published. */
  baseSupportDigest?: string
}

export interface CliToolRecord {
  current: string | null
  /** Set by an administrator catalog; keeps the tool out of new executions. */
  revoked: boolean
  /** Set by the user; kept apart from `revoked` so neither overrides the other. */
  disabled?: boolean
  /** The catalog no longer lists this catalog-sourced tool at all. */
  delisted?: boolean
  /** Highest approved catalog version above every installed one; never downloaded on its own. */
  catalogUpdate?: string
  /**
   * The catalog delivers this tool to every device: the host installs its
   * versions without asking, and its catalog versions cannot be deleted.
   */
  autoInstall?: true
  versions: Record<string, CliToolVersionRecord>
}

/** A delivered version this device refused; not tried again while the catalog lists the same content. */
export interface CliDeliveryFailure {
  integrity: string
  code: CliToolErrorCode
  at: string
}

export interface CliToolState {
  schema: 1
  /** Changes on each committed change to the usable tool set, including a return to an earlier set. */
  currentToolsRevision?: string
  currentToolsFingerprint?: string
  tools: Record<string, CliToolRecord>
  /**
   * Store directories (relative to root) whose records were removed while a
   * running execution still pinned them; deleted by `collectPendingCleanup`.
   */
  pendingCleanup?: string[]
  /** Keyed `id@version`; dropped once the catalog stops listing that version. */
  deliveryFailures?: Record<string, CliDeliveryFailure>
}

/** What a package would install, read in staging without running any of it. */
export interface PackagePreview {
  id: string
  version: string
  name?: string
  description?: string
  commands: string[]
  platforms: string[]
  minNode?: string
  sideEffects?: CliManifest['sideEffects']
  auth?: NonNullable<CliManifest['auth']>['method']
  archiveSha256: string
  integrity: string
  archiveBytes: number
  payloadBytes: number
  files: number
  /** The skill the package would get before any administrator text. */
  skill: CliToolSkillSummary
}

/** A tool's skill as the management view and the import preview show it. */
export interface CliToolSkillSummary {
  name: string
  description: string
  source: CliSkillSource
}

export interface RegisterExternalOptions {
  path: string
  interpreter: 'halo-node' | null
  command: string
  name: string
  description?: string
  /** Attach to an installed tool instead of creating `external.<command>`. */
  toolId?: string
}

/** An administrator's guide for one catalog version, replacing the package guide. */
export interface CatalogGuideOverride {
  revision: number
  /** Lowercase hex sha256 of `content` (UTF-8). */
  sha256: string
  content: string
  /** Checked by the host before the store sees it (see signature.ts). */
  signature?: CatalogSignature | null
}

/** Catalog facts about one tool, as `applyCatalogStatus` consumes them. */
export interface CatalogToolStatus {
  id: string
  revoked: boolean
  /** The catalog delivers this tool to every device (see `CliToolRecord.autoInstall`). */
  autoInstall?: boolean
  /** Approved versions the catalog lists now. */
  versions: string[]
  /**
   * Guide state per listed version, keyed by version. `override: null` means
   * the package guide applies; a version absent here is left as it is.
   * Applied only to an installed preset or catalog version whose payload
   * integrity equals `integrity`.
   */
  guides?: Record<string, { integrity: string; override: CatalogGuideOverride | null }>
  /**
   * The tool's skill, for installed preset versions that `guides` does not
   * cover. `null`: the catalog sets none, so a skill applied earlier is
   * cleared. Absent: leave those versions as they are.
   */
  skill?: CatalogGuideOverride | null
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
  /** Tools whose process receives a host-held credential (see credentials.ts). */
  credentialBindings?: CliCredentialBinding[]
  supportFiles?: CliSupportFilesConfig
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
  /** The build's offline expectations, consulted only for preset imports. */
  presetCatalog?: PresetCatalog
}

export interface ImportResult {
  id: string
  version: string
  integrity: string
  /** False when the identical content was already installed. */
  installed: boolean
  /** This preset was governed by the optional bundled catalog. */
  matchedPresetCatalog?: true
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
  tools: Array<{
    id: string
    version: string
    integrity: string
    guide?: string
    guideOverride?: { revision: number; sha256: string }
    supportDigest?: string
    supportVariant?: true
    supportCheck?: SupportCheck | null
  }>
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

export { GUIDE_MAX_BYTES } from './skills'

const STATE_MAX_BYTES = 1024 * 1024
const GUIDE_SHA256 = /^[0-9a-f]{64}$/
/** Same rule as manifest command names: bare, lowercase, never the reserved `halo-` prefix. */
export const COMMAND_NAME_PATTERN = /^(?!halo-)[a-z0-9][a-z0-9._-]{0,63}$/
const TOOL_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const SCRIPT_EXTENSIONS = /\.(c|m)?js$/i
const WINDOWS_EXECUTABLE = /\.(exe|cmd|bat|com)$/i

/** Compare dotted numeric versions (semver core, prerelease ignored); non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const core = (v: string) => v.split(/[-+]/)[0].split('.').map(n => Number.parseInt(n, 10) || 0)
  const pa = core(a)
  const pb = core(b)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  // Same core: a release sorts above its prereleases.
  const preA = a.includes('-')
  const preB = b.includes('-')
  if (preA !== preB) return preA ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Whether a tool may enter a new execution, and why not. Withdrawn versions
 * stay usable; everything else listed here keeps the tool out.
 */
export function toolBlock(tool: CliToolRecord): 'no-current' | 'revoked' | 'delisted' | 'external-changed' | 'disabled' | null {
  const record = tool.current ? tool.versions[tool.current] : undefined
  if (!tool.current || !record) return 'no-current'
  if (tool.revoked) return 'revoked'
  if (tool.delisted && record.source === 'catalog') return 'delisted'
  if (record.external?.changed) return 'external-changed'
  if (tool.disabled) return 'disabled'
  return null
}

/** Drop failures of versions the catalog no longer lists as they failed; true when any was dropped. */
function pruneDeliveryFailures(state: CliToolState, catalog: Map<string, CatalogToolStatus>): boolean {
  const failures = state.deliveryFailures
  if (!failures) return false
  let pruned = false
  for (const [key, failure] of Object.entries(failures)) {
    const at = key.lastIndexOf('@')
    const entry = catalog.get(key.slice(0, at))
    const version = key.slice(at + 1)
    // `guides` omits a version only when its guide is malformed; listing then decides.
    const listed = entry?.guides?.[version]
      ? entry.guides[version].integrity === failure.integrity
      : entry?.versions.includes(version)
    if (listed) continue
    delete failures[key]
    pruned = true
  }
  if (Object.keys(failures).length === 0) delete state.deliveryFailures
  return pruned
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await fsp.open(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}
const MAX_PATH_ENTRIES = 256
const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/**
 * Whether `link` is a link to `target`. A stale link is removed, never
 * followed; anything else at that path is left alone and reported.
 */
async function linksTo(link: string, target: string): Promise<boolean> {
  const stat = await fsp.lstat(link).catch(() => null)
  if (!stat) return false
  if (!stat.isSymbolicLink()) throw new Error('the runtime link path is taken by something else')
  const normalize = (value: string) => value.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase()
  if (normalize(await fsp.readlink(link)) === normalize(target)) return true
  await fsp.unlink(link)
  return false
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function currentToolRecords(state: CliToolState) {
  return Object.keys(state.tools).sort().flatMap(id => {
    const tool = state.tools[id]
    if (toolBlock(tool) !== null) return []
    const record = tool.versions[tool.current!]
    return record.commands.length > 0 ? [{ id, version: tool.current!, record }] : []
  })
}

function toolSkillFingerprint(record: CliToolVersionRecord): string {
  return sha256(JSON.stringify([record.integrity, record.guideOverride?.sha256, record.name, record.description]))
}

function currentToolsRevision(state: CliToolState): string {
  return sha256(JSON.stringify(currentToolRecords(state).map(({ id, version, record }) => [
    id, version, toolSkillFingerprint(record), record.external?.sha256,
  ])))
}

/** Read only the beginning of a guide to find its frontmatter. */
async function readGuideHead(path: string): Promise<{ text: string } | null> {
  const limit = 8 * 1024
  let handle: fsp.FileHandle | null = null
  try {
    handle = await fsp.open(path, 'r')
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0)
    return { text: buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf-8') }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
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
  private readonly bindings = new Map<string, CliCredentialBinding>()
  private readonly supportFilesConfig: CliSupportFilesConfig | undefined
  private supportFiles?: Awaited<ReturnType<typeof loadSupportFiles>>
  private canonicalRoot?: string
  private readonly currentToolsChanged = new Emitter<string>()
  readonly onDidChangeCurrentTools = this.currentToolsChanged.event
  private currentRevision: string | undefined
  private currentFingerprint: string | undefined
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
    this.supportFilesConfig = options.supportFiles
    for (const candidate of options.credentialBindings ?? []) {
      const checked = validateCredentialBinding(candidate)
      if (checked.ok) this.bindings.set(checked.binding.toolId, checked.binding)
      else this.log.error('[CliTools] Credential binding ignored', { tool: candidate?.toolId, field: checked.field })
    }
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

  /** Revision loaded during preparation or assigned by the last committed mutation. */
  get preparedCurrentToolsRevision(): string | undefined {
    return this.currentRevision
  }

  private async writeState(state: CliToolState): Promise<void> {
    const previous = state.currentToolsRevision ?? this.currentRevision
    const fingerprint = currentToolsRevision(state)
    const revision = (state.currentToolsFingerprint ?? this.currentFingerprint) === fingerprint ? previous ?? fingerprint : randomUUID()
    state.currentToolsRevision = revision
    state.currentToolsFingerprint = fingerprint
    await fsp.mkdir(this.root, { recursive: true })
    await writeFileAtomic(this.path('state.json'), `${JSON.stringify(state, null, 2)}\n`)
    this.currentRevision = revision
    this.currentFingerprint = fingerprint
    if (revision !== previous) this.currentToolsChanged.fire(revision)
  }

  /** Only the descriptions for changed inputs need to read package or override guides. */
  async readCurrentToolSkills() {
    const state = await this.readState()
    const tools = currentToolRecords(state)
    return {
      revision: state.currentToolsRevision ?? currentToolsRevision(state),
      skills: tools.map(({ id, record }) => ({
        toolId: id,
        fingerprint: toolSkillFingerprint(record),
        describe: async (): Promise<CliToolSkill> => ({
          toolId: id,
          name: cliSkillName(id),
          description: (await this.describeSkill(id, record)).description,
          body: renderCliSkill(id),
        }),
      })),
    }
  }

  private hasRequiredSupport(): boolean {
    const config = this.supportFilesConfig
    return config !== undefined && (!Array.isArray(config.files) || config.files.length > 0)
  }

  private async readSupportFiles(): ReturnType<typeof loadSupportFiles> {
    return this.supportFiles ??= await loadSupportFiles(this.supportFilesConfig, this.log)
  }

  private versionDir(id: string, version: string, integrity: string): string {
    return `store/${id}/${version}-${integrityShortHex(integrity)}`
  }

  private variantParent(dir: string): string {
    return `support/${dir.slice('store/'.length)}`
  }

  private async selectSupport(record: CliToolVersionRecord): Promise<Pick<CliExecutionLock['tools'][number], 'supportDigest' | 'supportVariant' | 'supportCheck'>> {
    if (record.external || (!this.supportFilesConfig && !record.baseSupportDigest)) return {}
    const files = await this.readSupportFiles()
    if (files.length === 0 && !record.baseSupportDigest) return {}
    const expected = supportExpectations(files)
    const digest = supportDigest(expected)
    this.canonicalRoot ??= await fsp.realpath(this.root)
    const base = join(this.canonicalRoot, record.dir)
    const required = files.length > 0
    if (required) await this.assertSupportPackage(base, record)
    if (digest === record.baseSupportDigest) {
      const supportCheck = { root: base, files: expected }
      if (required) await assertSupportFiles(supportCheck)
      return { supportDigest: digest, ...(required ? { supportCheck } : {}) }
    }

    const parent = join(this.canonicalRoot, this.variantParent(record.dir))
    const target = join(parent, digest)
    const supportCheck = { root: target, files: expected }
    if (!(required ? await supportPathExists(target) : existsSync(target))) {
      const staging = join(this.canonicalRoot, 'staging', randomUUID())
      let published = false
      try {
        await fsp.mkdir(staging, { recursive: true })
        if (required) await assertRealDirectories(staging)
        await copyPackageTree(base, staging)
        await placeSupportFiles(staging, files, this.log)
        if (required) {
          await this.assertSupportPackage(staging, record)
          await assertSupportFiles({ ...supportCheck, root: staging })
        }
        await fsp.mkdir(parent, { recursive: true })
        if (required) await assertRealDirectories(parent)
        await fsp.rename(staging, target)
        published = true
        await setTreeReadOnly(target, true, this.platform)
      } catch (error) {
        const dir = published ? target : staging
        await setTreeReadOnly(dir, false, this.platform).catch(() => undefined)
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    }
    if (required) {
      await this.assertSupportPackage(target, record)
      await assertSupportFiles(supportCheck)
    }
    return { supportDigest: digest, supportVariant: true, ...(required ? { supportCheck } : {}) }
  }

  private async readSupportMarker(path: string): Promise<string> {
    const stat = await fsp.lstat(path)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64) throw supportError()
    const marker = await fsp.readFile(path, 'utf-8')
    if (!/^[0-9a-f]{64}$/.test(marker)) throw supportError()
    return marker
  }

  private async assertSupportPackage(root: string, record: Pick<CliToolVersionRecord, 'commands'>): Promise<void> {
    await assertRealDirectories(join(root, 'payload'))
    if (!(await fsp.lstat(join(root, 'manifest.json'))).isFile()) throw supportError()
    for (const { entry } of record.commands) {
      const path = join(root, 'payload', entry)
      await assertRealDirectories(dirname(path))
      if (!(await fsp.lstat(path)).isFile() || await fsp.realpath(path) !== path) throw supportError()
    }
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

  /**
   * Extract into `staging` and run every check an import runs: digests,
   * manifest, host support, paths, the pure-JS rule, entries and guide. Files
   * are only read and hashed; nothing in the package is executed.
   */
  private async stagePackage(
    archivePath: string,
    staging: string,
    options: Pick<ImportOptions, 'expectedArchiveSha256' | 'expectedIntegrity' | 'expectedTool'>,
    onStage: (stage: string) => void = () => undefined,
    onLabel: (label: string) => void = () => undefined,
  ) {
    onStage('extract')
    const archive = await extractPackageArchive(archivePath, staging, this.limits)
    if (options.expectedArchiveSha256 && options.expectedArchiveSha256.toLowerCase() !== archive.archiveSha256) {
      throw new CliToolError('DIGEST_MISMATCH', 'package archive digest differs from the expected digest')
    }

    onStage('manifest')
    const manifest = parseCliManifest(await fsp.readFile(join(staging, 'manifest.json'), 'utf-8'))
    const label = `${manifest.id}@${manifest.version}`
    onLabel(label)
    const expected = options.expectedTool
    if (expected && (expected.id !== manifest.id || expected.version !== manifest.version)) {
      throw new CliToolError('PACKAGE_INVALID', `package declares ${label}, expected ${expected.id}@${expected.version}`)
    }
    assertManifestSupported(manifest, {
      platform: this.platform,
      arch: this.arch,
      nodeVersion: this.runtimeNodeVersion,
    })

    onStage('payload')
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
    return { archive, manifest, inspection }
  }

  /**
   * Validate a package exactly as an import would and describe it, then
   * discard the staging copy. Nothing is installed and nothing in the package
   * runs; a non-compliant package throws the same typed error an import would.
   */
  previewPackage(archivePath: string): Promise<PackagePreview> {
    return this.serialize(async () => {
      const staging = this.path('staging', randomUUID())
      try {
        await fsp.mkdir(staging, { recursive: true })
        const { archive, manifest, inspection } = await this.stagePackage(archivePath, staging, {})
        const archiveBytes = (await fsp.stat(archivePath)).size
        const guide = manifest.guide ? await readGuideHead(join(staging, manifest.guide)) : null
        const skill = {
          name: cliSkillName(manifest.id),
          ...resolveSkillDescription({
            package: guide ? splitGuide(guide.text).description : undefined,
            manifest: manifest.description,
            toolName: manifest.name ?? manifest.id,
          }),
        }
        return {
          id: manifest.id,
          version: manifest.version,
          ...(manifest.name ? { name: manifest.name } : {}),
          ...(manifest.description ? { description: manifest.description } : {}),
          commands: manifest.commands.map(c => c.name),
          platforms: manifest.platforms,
          ...(manifest.runtime.minNode ? { minNode: manifest.runtime.minNode } : {}),
          ...(manifest.sideEffects ? { sideEffects: manifest.sideEffects } : {}),
          ...(manifest.auth ? { auth: manifest.auth.method } : {}),
          archiveSha256: archive.archiveSha256,
          integrity: inspection.integrity,
          archiveBytes,
          payloadBytes: inspection.bytes,
          files: inspection.files,
          skill,
        }
      } finally {
        await setTreeReadOnly(staging, false, this.platform).catch(() => undefined)
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
    })
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

      const { archive, manifest, inspection } = await this.stagePackage(archivePath, staging, options, s => {
        stage = s
      }, l => {
        label = l
      })

      stage = 'preset-catalog'
      const presetCatalog = options.source === 'preset' ? options.presetCatalog : undefined
      const match = presetCatalog?.resolve(basename(archivePath), manifest, archive.archiveSha256)
      const matched = match ? { matchedPresetCatalog: true as const } : {}
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
        stage = 'support'
        await this.selectSupport(existing)
        await fsp.rm(staging, { recursive: true, force: true })
        const previous = tool.current
        stage = 'preset-guide'
        const guideChanged = match && !tool.revoked && existing.archiveSha256 === archive.archiveSha256 &&
          await this.applyBundledGuide(label, existing, match.guide)
        if (activate && tool.current !== manifest.version) tool.current = manifest.version
        if (guideChanged || previous !== tool.current) await this.writeState(state)
        this.log.log('[CliTools] Import matched an installed version', { tool: label, current: tool.current })
        return {
          id: manifest.id, version: manifest.version, integrity: inspection.integrity,
          installed: false, current: tool.current, previous, ...matched,
        }
      }

      const dirRel = this.versionDir(manifest.id, manifest.version, inspection.integrity)
      const target = this.path(dirRel)
      let baseSupportDigest: string | undefined
      stage = 'support'
      const files = await this.readSupportFiles()
      if (state.pendingCleanup?.includes(dirRel) && (files.length ? await supportPathExists(target) : existsSync(target))) {
        if (files.length) await this.assertSupportPackage(join(await fsp.realpath(this.root), dirRel), manifest)
        const marker = join(target, BASE_SUPPORT_FILE)
        if (files.length && await supportPathExists(marker)) baseSupportDigest = await this.readSupportMarker(marker)
        else if (!files.length && existsSync(marker)) baseSupportDigest = (await fsp.readFile(marker, 'utf-8')).trim()
        await fsp.rm(staging, { recursive: true, force: true })
      } else {
        if (files.length > 0) {
          const expected = supportExpectations(files)
          const canonicalRoot = this.canonicalRoot ??= await fsp.realpath(this.root)
          const canonicalStaging = join(canonicalRoot, 'staging', txid)
          await assertRealDirectories(canonicalStaging)
          await placeSupportFiles(canonicalStaging, files, this.log)
          await assertSupportFiles({ root: canonicalStaging, files: expected })
          baseSupportDigest = supportDigest(expected)
          await fsp.writeFile(join(staging, BASE_SUPPORT_FILE), baseSupportDigest, { flag: 'wx', mode: 0o444 })
          await fsp.mkdir(join(canonicalRoot, 'store', manifest.id), { recursive: true })
          await assertRealDirectories(join(canonicalRoot, 'store', manifest.id))
          if (await supportPathExists(target)) throw supportError()
        }
        stage = 'publish'
        await fsp.mkdir(this.path('store', manifest.id), { recursive: true })
        // Nothing refers to the target until state.json is written below.
        await this.deleteStoreDir(dirRel)
        await fsp.rename(staging, target)
        published = target
        await setTreeReadOnly(target, true, this.platform)
      }

      const previous = tool.current
      tool.versions[manifest.version] = {
        integrity: inspection.integrity,
        archiveSha256: archive.archiveSha256,
        dir: dirRel,
        source: options.source,
        importedAt: new Date().toISOString(),
        commands: manifest.commands.map(c => ({ name: c.name, entry: c.entry })),
        ...(baseSupportDigest ? { baseSupportDigest } : {}),
        ...(manifest.runtime.minNode ? { minNode: manifest.runtime.minNode } : {}),
        ...(manifest.guide ? { guide: manifest.guide } : {}),
        ...(manifest.sideEffects ? { sideEffects: manifest.sideEffects } : {}),
        ...(manifest.auth ? { auth: manifest.auth.method } : {}),
        ...(manifest.name ? { name: manifest.name } : {}),
        ...(manifest.description ? { description: manifest.description } : {}),
      }
      if (!published) await this.selectSupport(tool.versions[manifest.version])
      stage = 'preset-guide'
      if (match && !tool.revoked) await this.applyBundledGuide(label, tool.versions[manifest.version], match.guide)
      // Reinstalling content a pending cleanup still lists must not lose it later.
      if (state.pendingCleanup) {
        state.pendingCleanup = state.pendingCleanup.filter(d => d !== dirRel)
        if (state.pendingCleanup.length === 0) delete state.pendingCleanup
      }
      // The offered update is now installed (or overtaken): stop offering it until the next catalog read.
      if (tool.catalogUpdate && compareVersions(manifest.version, tool.catalogUpdate) >= 0) delete tool.catalogUpdate
      if (state.deliveryFailures?.[label]) {
        delete state.deliveryFailures[label]
        if (Object.keys(state.deliveryFailures).length === 0) delete state.deliveryFailures
      }
      if ((activate || tool.current === null) && !(match && tool.revoked)) tool.current = manifest.version
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
        installed: true, current: tool.current, previous, ...matched,
      }
    } catch (error) {
      const err = stage === 'support' ? supportError() : error
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

  /** Exclude (or re-admit) a tool for new executions by the user's choice. Running pins are unaffected. */
  setDisabled(id: string, disabled: boolean): Promise<void> {
    return this.serialize(async () => {
      const state = await this.readState()
      const tool = state.tools[id]
      if (!tool) throw new CliToolError('NOT_FOUND', `${id} is not installed`)
      if (disabled) tool.disabled = true
      else delete tool.disabled
      await this.writeState(state)
      this.log.log('[CliTools] User disable changed', { tool: id, disabled })
    })
  }

  /**
   * Delete one installed version's record. The current version is refused
   * (IN_USE: choose another first, or remove the whole tool), and so is a
   * version shipped with the build (PRESET_PROTECTED) or delivered by the
   * catalog (ADMIN_MANAGED): disable those instead.
   * Files a running execution still pins are kept and listed for cleanup at
   * the next start; a registered program's file is never touched.
   */
  removeVersion(id: string, version: string): Promise<{ deferred: boolean }> {
    return this.serialize(async () => {
      const state = await this.readState()
      const tool = state.tools[id]
      const record = tool?.versions[version]
      if (!tool || !record) throw new CliToolError('NOT_FOUND', `${id}@${version} is not installed`)
      if (record.source === 'preset') {
        throw new CliToolError('PRESET_PROTECTED', `${id}@${version} ships with Halo; disable it instead`)
      }
      if (record.source === 'catalog' && tool.autoInstall) {
        throw new CliToolError('ADMIN_MANAGED', `${id}@${version} is delivered by the administrator; disable it instead`)
      }
      if (tool.current === version) {
        throw new CliToolError('IN_USE', `${id}@${version} is the current version`)
      }
      delete tool.versions[version]
      if (Object.keys(tool.versions).length === 0) delete state.tools[id]
      const deferred = await this.dropFiles(state, [{ id, version, record }])
      this.log.log('[CliTools] Removed version', { tool: `${id}@${version}`, deferred: deferred.length > 0 })
      return { deferred: deferred.length > 0 }
    })
  }

  /**
   * Remove a tool and every version of it. Refused while it holds a version
   * shipped with the build or the catalog delivers it. Same reference rule as
   * `removeVersion`.
   */
  removeTool(id: string): Promise<{ deferred: number }> {
    return this.serialize(async () => {
      const state = await this.readState()
      const tool = state.tools[id]
      if (!tool) throw new CliToolError('NOT_FOUND', `${id} is not installed`)
      if (Object.values(tool.versions).some(v => v.source === 'preset')) {
        throw new CliToolError('PRESET_PROTECTED', `${id} ships with Halo; disable it instead`)
      }
      if (tool.autoInstall) {
        throw new CliToolError('ADMIN_MANAGED', `${id} is delivered by the administrator; disable it instead`)
      }
      const victims = Object.entries(tool.versions).map(([version, record]) => ({ id, version, record }))
      delete state.tools[id]
      const deferred = await this.dropFiles(state, victims)
      this.log.log('[CliTools] Removed tool', { tool: id, versions: victims.length, deferred: deferred.length })
      return { deferred: deferred.length }
    })
  }

  /**
   * Write `state` (whose records no longer name `victims`), then delete the
   * victims' store directories that no lock pins. Pinned ones go to
   * `pendingCleanup`. State is written first: a crash afterwards leaves an
   * orphan directory, never a record pointing at deleted files.
   */
  private async dropFiles(
    state: CliToolState,
    victims: Array<{ id: string; version: string; record: CliToolVersionRecord }>,
  ): Promise<string[]> {
    const locks = await this.listExecutionLocks()
    const now: string[] = []
    const deferred: string[] = []
    for (const { id, version, record } of victims) {
      if (record.external || !record.dir) continue
      const pinned = locks.some(lock => lock.tools.some(t => t.id === id && t.version === version && t.integrity === record.integrity))
      if (pinned) deferred.push(record.dir)
      else now.push(record.dir)
    }
    if (deferred.length > 0) {
      state.pendingCleanup = [...new Set([...(state.pendingCleanup ?? []), ...deferred])]
    }
    await this.writeState(state)
    for (const rel of now) await this.deleteVersionDirs(rel)
    return deferred
  }

  private async deleteStoreDir(rel: string): Promise<void> {
    const dir = this.path(...rel.split('/'))
    if (!existsSync(dir)) return
    await setTreeReadOnly(dir, false, this.platform)
    await fsp.rm(dir, { recursive: true, force: true })
  }

  private async deleteVersionDirs(rel: string): Promise<void> {
    await this.deleteStoreDir(this.variantParent(rel))
    await this.deleteStoreDir(rel)
  }

  /**
   * Delete directories waiting in `pendingCleanup` that no record and no lock
   * refers to any more. Run after earlier processes' locks are released.
   * Returns the number deleted.
   */
  collectPendingCleanup(): Promise<number> {
    return this.serialize(async () => {
      const state = await this.readState()
      this.currentFingerprint = state.currentToolsFingerprint ?? currentToolsRevision(state)
      this.currentRevision = state.currentToolsRevision ?? this.currentFingerprint
      const pending = state.pendingCleanup ?? []
      if (pending.length === 0) return 0
      const recorded = new Set<string>()
      for (const tool of Object.values(state.tools)) for (const v of Object.values(tool.versions)) if (v.dir) recorded.add(v.dir)
      const pinned = new Set<string>()
      for (const lock of await this.listExecutionLocks()) {
        for (const t of lock.tools) pinned.add(`store/${t.id}/${t.version}-${integrityShortHex(t.integrity)}`)
      }
      const keep: string[] = []
      let removed = 0
      for (const rel of pending) {
        if (recorded.has(rel)) continue
        if (pinned.has(rel)) { keep.push(rel); continue }
        await this.deleteVersionDirs(rel)
        removed += 1
      }
      if (keep.length > 0) state.pendingCleanup = keep
      else delete state.pendingCleanup
      await this.writeState(state)
      if (removed > 0) this.log.log('[CliTools] Cleaned up removed versions', { removed, waiting: keep.length })
      return removed
    })
  }

  // ── registered existing programs ─────────────────────────────────────

  /** Fingerprint a program file; EXTERNAL_INVALID when it is not a usable file. */
  private async fingerprint(path: string, interpreter: 'halo-node' | null) {
    if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new CliToolError('EXTERNAL_INVALID', 'program path must be absolute')
    const stat = await fsp.stat(path).catch(() => null)
    if (!stat?.isFile()) throw new CliToolError('EXTERNAL_INVALID', 'program path is not a file')
    if (interpreter === 'halo-node') {
      if (!SCRIPT_EXTENSIONS.test(path)) throw new CliToolError('EXTERNAL_INVALID', 'only .js, .mjs or .cjs scripts run on the bundled Node')
    } else if (this.platform === 'win32') {
      if (!WINDOWS_EXECUTABLE.test(path)) throw new CliToolError('EXTERNAL_INVALID', 'program is not an executable file')
    } else if ((stat.mode & 0o111) === 0) {
      throw new CliToolError('EXTERNAL_INVALID', 'program is not executable')
    }
    return { sha256: await fileSha256(path), size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) }
  }

  /**
   * Register a program already on this computer. Only a record is stored —
   * path, interpreter, fingerprint and time; the file is never copied or
   * changed. The tool becomes current only when it had no current version.
   */
  registerExternal(options: RegisterExternalOptions): Promise<{ id: string; current: string | null }> {
    return this.serialize(async () => {
      if (!COMMAND_NAME_PATTERN.test(options.command)) {
        throw new CliToolError('EXTERNAL_INVALID', 'command name must be lowercase letters, digits, . _ - and not start with halo-')
      }
      const name = options.name.trim()
      if (!name || name.length > 128) throw new CliToolError('EXTERNAL_INVALID', 'display name is required (max 128)')
      const description = options.description?.trim().slice(0, 1024)
      const id = options.toolId ?? `external.${options.command.replace(/[._]+/g, '-').replace(/^-+|-+$/g, '')}`
      if (!TOOL_ID_PATTERN.test(id) || id.length > 128) throw new CliToolError('EXTERNAL_INVALID', 'tool id is not valid')
      const fp = await this.fingerprint(options.path, options.interpreter)
      const state = await this.readState()
      if (options.toolId && !state.tools[id]) throw new CliToolError('NOT_FOUND', `${id} is not installed`)
      const tool: CliToolRecord = state.tools[id] ?? { current: null, revoked: false, versions: {} }
      if (tool.versions[EXTERNAL_VERSION]) {
        throw new CliToolError('VERSION_CONFLICT', `${id} already has a registered program; remove it first`)
      }
      tool.versions[EXTERNAL_VERSION] = {
        integrity: `sha256-${Buffer.from(fp.sha256, 'hex').toString('base64')}`,
        archiveSha256: '',
        dir: '',
        source: 'external',
        importedAt: new Date().toISOString(),
        commands: [{ name: options.command, entry: options.path }],
        name,
        ...(description ? { description } : {}),
        external: {
          path: options.path,
          interpreter: options.interpreter,
          ...fp,
          registeredAt: new Date().toISOString(),
        },
      }
      if (tool.current === null) tool.current = EXTERNAL_VERSION
      state.tools[id] = tool
      await this.writeState(state)
      this.log.log('[CliTools] Registered existing program', { tool: id, interpreter: options.interpreter ?? 'direct' })
      return { id, current: tool.current }
    })
  }

  /** The user re-confirms a changed program: take its fingerprint again and re-admit it. */
  reconfirmExternal(id: string): Promise<void> {
    return this.serialize(async () => {
      const state = await this.readState()
      const record = state.tools[id]?.versions[EXTERNAL_VERSION]
      if (!record?.external) throw new CliToolError('NOT_FOUND', `${id} has no registered program`)
      const fp = await this.fingerprint(record.external.path, record.external.interpreter)
        .catch(err => {
          throw isCliToolError(err) && err.code === 'EXTERNAL_INVALID'
            ? new CliToolError('NOT_FOUND', 'the registered program is missing or unusable')
            : err
        })
      record.external = { ...record.external, ...fp }
      delete record.external.changed
      record.integrity = `sha256-${Buffer.from(fp.sha256, 'hex').toString('base64')}`
      await this.writeState(state)
      this.log.log('[CliTools] Registered program re-confirmed', { tool: id })
    })
  }

  /**
   * Check the current registered programs before a pin: size and mtime
   * first, the hash only when they moved. A missing or different file is
   * marked changed (and so excluded); an identical one just refreshes its
   * stamp. Returns true when state changed and was written.
   */
  private async checkExternals(state: CliToolState): Promise<boolean> {
    let dirty = false
    for (const [id, tool] of Object.entries(state.tools)) {
      const record = tool.current ? tool.versions[tool.current] : undefined
      const ext = record?.external
      if (!ext || ext.changed) continue
      const stat = await fsp.stat(ext.path).catch(() => null)
      if (!stat?.isFile()) {
        ext.changed = 'missing'
        dirty = true
        this.log.error('[CliTools] Registered program is missing; held back until re-confirmed', { tool: id })
        continue
      }
      if (stat.size === ext.size && Math.trunc(stat.mtimeMs) === ext.mtimeMs) continue
      const sha = await fileSha256(ext.path).catch(() => null)
      if (sha === ext.sha256) {
        ext.size = stat.size
        ext.mtimeMs = Math.trunc(stat.mtimeMs)
      } else {
        ext.changed = 'modified'
        this.log.error('[CliTools] Registered program changed; held back until re-confirmed', { tool: id })
      }
      dirty = true
    }
    if (dirty) await this.writeState(state)
    return dirty
  }

  // ── catalog status ───────────────────────────────────────────────────

  /**
   * Apply what a freshly read administrator catalog says. For every listed
   * tool: its revocation flag (any source). For tools with catalog-sourced
   * versions: `delisted` when the catalog has neither an approved version
   * nor a revocation entry for it, `withdrawn` per version the catalog no
   * longer lists, and `catalogUpdate` when an approved version is above
   * every installed one. Administrator texts: each listed version's guide,
   * and the tool's skill for preset versions (see `applyToolSkill`). A
   * delivered tool whose versions are all withdrawn stays listed, so it is not
   * delisted. Nothing is downloaded. Returns the ids that changed.
   */
  applyCatalogStatus(catalog: CatalogToolStatus[]): Promise<string[]> {
    return this.serialize(async () => {
      const state = await this.readState()
      const byId = new Map(catalog.map(t => [t.id, t]))
      const changed: string[] = []
      for (const [id, tool] of Object.entries(state.tools)) {
        const before = JSON.stringify(tool)
        const entry = byId.get(id)
        if (entry) tool.revoked = entry.revoked
        // An entry without versions does not carry the flag, so it keeps the last one seen.
        if (entry?.autoInstall) tool.autoInstall = true
        else if (!entry || entry.versions.length > 0) delete tool.autoInstall
        const catalogVersions = Object.entries(tool.versions).filter(([, v]) => v.source === 'catalog')
        if (catalogVersions.length > 0) {
          const gone = !entry || (!entry.revoked && entry.versions.length === 0 && !tool.autoInstall)
          if (gone) tool.delisted = true
          else delete tool.delisted
          for (const [version, record] of catalogVersions) {
            if (entry && !entry.versions.includes(version)) record.withdrawn = true
            else delete record.withdrawn
          }
        }
        if (entry?.guides) await this.applyGuides(id, tool, entry.guides)
        if (entry && entry.skill !== undefined) await this.applyToolSkill(id, tool, entry.skill, entry.guides ?? {})
        const installed = Object.keys(tool.versions).filter(v => v !== EXTERNAL_VERSION)
        const best = entry && !entry.revoked
          ? [...entry.versions].sort(compareVersions).pop()
          : undefined
        if (best && installed.length > 0 && installed.every(v => compareVersions(best, v) > 0)) {
          tool.catalogUpdate = best
        } else {
          delete tool.catalogUpdate
        }
        if (JSON.stringify(tool) !== before) changed.push(id)
      }
      const prunedFailures = pruneDeliveryFailures(state, byId)
      if (changed.length > 0 || prunedFailures) {
        await this.writeState(state)
        if (changed.length > 0) this.log.log('[CliTools] Catalog status applied', { changed })
      }
      await this.pruneGuides(state)
      return changed
    })
  }

  /** Remember that a delivered version was refused here, so background reads do not try it again. */
  recordDeliveryFailure(id: string, version: string, failure: Omit<CliDeliveryFailure, 'at'>): Promise<void> {
    return this.serialize(async () => {
      const state = await this.readState()
      state.deliveryFailures = { ...state.deliveryFailures, [`${id}@${version}`]: { ...failure, at: new Date().toISOString() } }
      await this.writeState(state)
      this.log.error('[CliTools] Delivered version refused; retried when the catalog changes it or on the user\'s Sync', {
        tool: `${id}@${version}`, code: failure.code,
      })
    })
  }

  /**
   * Set or clear the administrator guide of each matching installed version.
   * The text is written once per content and re-checked here; a guide that
   * does not check out leaves the version as it was.
   */
  private async applyGuides(
    id: string,
    tool: CliToolRecord,
    guides: NonNullable<CatalogToolStatus['guides']>,
  ): Promise<void> {
    for (const [version, guide] of Object.entries(guides)) {
      const record = tool.versions[version]
      if (!record || (record.source !== 'catalog' && record.source !== 'preset')) continue
      if (record.integrity !== guide.integrity) continue
      const override = guide.override
      if (!override) {
        if (record.source === 'preset') record.liveGuideSeen = true
        delete record.guideOverride
        continue
      }
      if (!(await this.storeGuideText(`${id}@${version}`, override))) continue
      if (record.source === 'preset') record.liveGuideSeen = true
      const current = record.guideOverride
      if (current?.sha256 !== override.sha256 || current.revision !== override.revision || current.tool || current.bundled) {
        record.guideOverride = { revision: override.revision, sha256: override.sha256 }
      }
    }
  }

  /**
   * Give the tool's skill to installed preset versions: they are not in the
   * catalog, so no version guide reaches them. A version `guides` applied to,
   * or one holding a guide set for that version, keeps it.
   */
  private async applyToolSkill(
    id: string,
    tool: CliToolRecord,
    skill: CatalogGuideOverride | null,
    guides: NonNullable<CatalogToolStatus['guides']>,
  ): Promise<void> {
    const targets = Object.entries(tool.versions).filter(([version, record]) =>
      record.source === 'preset' &&
      guides[version]?.integrity !== record.integrity &&
      (!record.guideOverride || record.guideOverride.tool || record.guideOverride.bundled))
    if (targets.length === 0) return
    if (!skill) {
      for (const [, record] of targets) {
        record.liveGuideSeen = true
        delete record.guideOverride
      }
      return
    }
    if (!(await this.storeGuideText(id, skill))) return
    for (const [, record] of targets) {
      record.liveGuideSeen = true
      const current = record.guideOverride
      if (current?.sha256 !== skill.sha256 || current.revision !== skill.revision || current.bundled) {
        record.guideOverride = { revision: skill.revision, sha256: skill.sha256, tool: true }
      }
    }
  }

  private async applyBundledGuide(
    label: string,
    record: CliToolVersionRecord,
    guide: (CatalogGuideOverride & { tool: boolean }) | undefined,
  ): Promise<boolean> {
    const current = record.guideOverride
    if (record.source !== 'preset' || record.liveGuideSeen || (current && !current.bundled) || !guide) return false
    if (current && ((!current.tool && guide.tool) ||
      (!!current.tool === guide.tool && current.revision >= guide.revision))) return false
    if (!(await this.storeGuideText(label, guide))) return false
    record.guideOverride = { revision: guide.revision, sha256: guide.sha256, bundled: true, ...(guide.tool ? { tool: true } : {}) }
    return true
  }

  /**
   * Check an administrator text against its digest and limits and keep it as
   * `guides/<sha256>.md`, written once per content. False when it does not check out.
   */
  private async storeGuideText(label: string, override: CatalogGuideOverride): Promise<boolean> {
    const bytes = Buffer.byteLength(override.content, 'utf-8')
    if (!GUIDE_SHA256.test(override.sha256) || !Number.isInteger(override.revision) || override.revision < 1 ||
      bytes > GUIDE_MAX_BYTES || sha256(override.content) !== override.sha256) {
      this.log.error('[CliTools] Guide override ignored: it does not match its digest or limits', {
        tool: label, revision: override.revision,
      })
      return false
    }
    const file = this.path('guides', `${override.sha256}.md`)
    if (!existsSync(file)) {
      await fsp.mkdir(this.path('guides'), { recursive: true })
      await writeFileAtomic(file, override.content)
    }
    return true
  }

  /** Delete guide files no version record and no execution lock refers to. */
  private async pruneGuides(state: CliToolState): Promise<void> {
    let names: string[]
    try {
      names = await fsp.readdir(this.path('guides'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const referenced = new Set<string>()
    for (const tool of Object.values(state.tools)) {
      for (const record of Object.values(tool.versions)) {
        if (record.guideOverride) referenced.add(`${record.guideOverride.sha256}.md`)
      }
    }
    for (const lock of await this.listExecutionLocks()) {
      for (const pinned of lock.tools ?? []) {
        if (pinned.guideOverride) referenced.add(`${pinned.guideOverride.sha256}.md`)
      }
    }
    for (const name of names) {
      if (referenced.has(name) || name.includes('.tmp-')) continue
      await fsp.rm(this.path('guides', name), { force: true })
    }
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
    if (!existing) await this.checkExternals(state)
    if (existing) {
      const required = this.hasRequiredSupport()
      for (const pinned of existing.tools) {
        const record = state.tools[pinned.id]?.versions[pinned.version]
        if (pinned.supportCheck === undefined && required && record && !record.external) {
          this.log.error('[CliTools] Unguarded execution pin refused; create a new execution', { tool: pinned.id })
          throw supportError()
        }
        if (pinned.supportCheck) {
          try {
            await assertSupportFiles(pinned.supportCheck)
          } catch {
            this.log.error('[CliTools] Existing pin refused: required support files could not be verified', { tool: pinned.id })
            throw supportError()
          }
        }
      }
      const binDir = existing.commands.length > 0 ? await this.ensureView(existing, state) : null
      return { binDir, lock: existing, reused: true }
    }
    const lock = await this.composeLock(options, state)
    const binDir = lock.commands.length > 0 ? await this.ensureView(lock, state) : null
    await this.writeLock(lock)
    return { binDir, lock, reused: false }
  }

  /**
   * Pin the tool set that is current right now on behalf of `holder`. The
   * same holder, entry and tool set map to one lock
   * (`<holder>-<entry>-<viewKey>`), so a caller that assembles an environment
   * per request can call this every time: it gets the current set, a set it
   * used earlier stays pinned until that lock is released, and each lock
   * records the entry it serves. Nothing is written when no tool is usable.
   */
  pinCurrent(options: PinCurrentOptions): Promise<PinnedExecution | null> {
    return this.serialize(async () => {
      const state = await this.readState()
      if (!Object.values(state.tools).some(tool => toolBlock(tool) === null)) return null
      await this.checkExternals(state)
      const draft = await this.composeLock({ ...options, executionId: options.holder }, state)
      if (draft.commands.length === 0) return null
      const executionId = `${options.holder}-${options.entry}-${draft.viewKey}`
      const existing = await this.readExecutionLock(executionId)
      if (existing && existing.viewKey === draft.viewKey) {
        const lock = draft.tools.some(tool => tool.supportCheck !== undefined)
          ? { ...draft, executionId, holder: options.holder, createdAt: existing.createdAt } : existing
        return { binDir: await this.ensureView(lock, state), lock, reused: true }
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

  private async composeLock(options: PinExecutionOptions, state: CliToolState): Promise<CliExecutionLock> {
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
    let invalidDeployment = false
    for (const id of Object.keys(state.tools).sort()) {
      const tool = state.tools[id]
      if (toolBlock(tool) !== null || !tool.current) continue
      const record = tool.versions[tool.current]
      if (!record) continue
      let support: Pick<CliExecutionLock['tools'][number], 'supportDigest' | 'supportVariant' | 'supportCheck'> = {}
      if (!record.external && (this.hasRequiredSupport() || record.baseSupportDigest)) {
        try {
          if (invalidDeployment) throw supportError()
          await this.readSupportFiles().catch(error => {
            invalidDeployment = true
            throw error
          })
          support = await this.selectSupport(record)
        } catch {
          support = { supportCheck: null }
          if (!invalidDeployment) this.log.error('[CliTools] Managed command blocked: required support files could not be verified', { tool: id })
        }
      }
      tools.push({
        id,
        version: tool.current,
        integrity: record.integrity,
        ...support,
        ...(record.guide ? { guide: record.guide } : {}),
        ...(record.guideOverride
          ? { guideOverride: { revision: record.guideOverride.revision, sha256: record.guideOverride.sha256 } }
          : {}),
      })
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

  private launcherTargets(
    lock: CliExecutionLock,
    state: CliToolState,
  ): Array<{ exposedAs: string; entry: string; origin: ReturnType<typeof toolOrigin>; direct?: true; fingerprint?: string; credential?: CliCredentialBinding; supportDigest?: string; supportCheck?: SupportCheck | null }> {
    const pinnedTools = new Map(lock.tools.map(tool => [tool.id, tool]))
    return lock.commands.map(command => {
      const record = state.tools[command.toolId]?.versions[command.version]
      if (!record) {
        throw new CliToolError('NOT_FOUND', `${command.toolId}@${command.version} pinned by an execution is missing`)
      }
      const origin = toolOrigin(record.source)
      if (record.external) {
        // The fingerprint keys the view, so a re-confirmed program gets a new view and session.
        return {
          exposedAs: command.exposedAs,
          entry: record.external.path,
          origin,
          ...(record.external.interpreter === null ? { direct: true as const } : {}),
          fingerprint: record.external.sha256,
        }
      }
      const entry = record.commands.find(c => c.name === command.command)?.entry
      if (!entry) throw new CliToolError('NOT_FOUND', `command "${command.command}" is missing`)
      // Part of the view key: a bound tool gets its own view, unbound views keep theirs.
      const credential = sourceMayBind(record.source) ? this.bindings.get(command.toolId) : undefined
      const pinned = pinnedTools.get(command.toolId)
      const supportDigest = pinned?.supportDigest
      const supportCheck = pinned?.supportCheck
      const dir = pinned?.supportVariant && supportDigest && /^[0-9a-f]{64}$/.test(supportDigest)
        ? `${this.variantParent(record.dir)}/${supportDigest}` : record.dir
      return {
        exposedAs: command.exposedAs,
        entry: supportCheck === null ? '' : join(supportCheck?.root ??
          join(supportDigest ? this.canonicalRoot ?? this.root : this.root, dir), 'payload', entry),
        origin,
        ...(credential && supportCheck !== null ? { credential } : {}),
        ...(supportDigest ? { supportDigest } : {}),
        ...(supportCheck !== undefined ? { supportCheck } : {}),
      }
    })
  }

  private viewKeyOf(lock: CliExecutionLock, state: CliToolState): string {
    const targets = this.launcherTargets(lock, state)
    // Only present when an override is pinned, so views without one keep their keys.
    const guides = lock.tools.filter(t => t.guideOverride).map(t => [t.id, t.guideOverride?.sha256])
    return sha256(JSON.stringify({
      v: targets.some(target => target.supportCheck !== undefined) ? 7 : 6,
      platform: this.platform, runtime: this.runtimePath, targets, ...(guides.length > 0 ? { guides } : {}),
    })).slice(0, 20)
  }

  /**
   * The runtime path Windows launchers name. cmd.exe can misread a non-ASCII
   * path in a batch file, so a runtime in such a folder is reached through a
   * junction under the store root, which a launcher names by a plain-ASCII
   * relative path. Anything that keeps the junction from being made leaves the
   * real path in the launchers.
   */
  private async launcherRuntimePath(): Promise<string> {
    if (this.platform !== 'win32' || /^[\x20-\x7e]*$/.test(this.runtimePath)) return this.runtimePath
    const target = dirname(this.runtimePath)
    const link = this.path('runtime', sha256(target).slice(0, 16))
    try {
      if (!(await linksTo(link, target))) {
        await fsp.mkdir(dirname(link), { recursive: true })
        await fsp.symlink(target, link, 'junction').catch(async (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST' || !(await linksTo(link, target))) throw err
        })
      }
      return join(link, basename(this.runtimePath))
    } catch (err) {
      this.log.error('[CliTools] Runtime link could not be created', {
        message: err instanceof Error ? err.message : String(err),
      })
      return this.runtimePath
    }
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
    if (lock.tools.some(tool => tool.supportDigest && !tool.supportCheck)) this.canonicalRoot ??= await fsp.realpath(this.root)

    const tmp = this.path('views', `.tmp-${randomUUID()}`)
    try {
      await fsp.mkdir(join(tmp, 'bin'), { recursive: true })
      // Launchers name the preload by its final path, where the view lands after the rename.
      await fsp.writeFile(join(tmp, ARGV_PRELOAD_FILE), renderArgvPreload(), 'utf-8')
      const preloadPath = join(viewDir, ARGV_PRELOAD_FILE)
      const runtimePath = await this.launcherRuntimePath()
      for (const [index, target] of this.launcherTargets(lock, state).entries()) {
        let supportPreloadPath: string | undefined
        if (target.supportCheck !== undefined) {
          const file = `support-${index}.cjs`
          await fsp.writeFile(join(tmp, file), renderSupportPreload(target.supportCheck), 'utf-8')
          supportPreloadPath = join(viewDir, file)
        }
        let credentialPreloadPath: string | undefined
        if (target.credential) {
          const file = credentialPreloadFile(index)
          await fsp.writeFile(join(tmp, file), renderCredentialPreload(target.credential), 'utf-8')
          credentialPreloadPath = join(viewDir, file)
        }
        const paths = {
          runtimePath, preloadPath, supportPreloadPath, credentialPreloadPath, binDir,
          entryPath: target.supportCheck === null ? supportPreloadPath! : target.entry,
          direct: target.direct === true,
        }
        for (const file of launcherFiles(this.platform, target.exposedAs, paths)) {
          const path = join(tmp, 'bin', file.name)
          await fsp.writeFile(path, file.content, { encoding: 'utf-8', mode: file.executable ? 0o755 : 0o644 })
        }
      }
      const overridden = await this.copyGuideOverrides(lock, join(tmp, 'guides'))
      await fsp.writeFile(join(tmp, 'TOOLS.md'), this.renderToolsGuide(lock, state, viewDir, overridden), 'utf-8')
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
   * Copy the guide overrides a lock pins into the view, so a later edit never
   * changes what a running execution reads. A missing or altered file is
   * logged and that tool falls back to its package guide. Returns the IDs copied.
   */
  private async copyGuideOverrides(lock: CliExecutionLock, dir: string): Promise<Set<string>> {
    const copied = new Set<string>()
    for (const pinned of lock.tools) {
      if (!pinned.guideOverride) continue
      let text: string | null = null
      try {
        text = await fsp.readFile(this.path('guides', `${pinned.guideOverride.sha256}.md`), 'utf-8')
      } catch {
        text = null
      }
      if (text === null || sha256(text) !== pinned.guideOverride.sha256) {
        this.log.error('[CliTools] Guide override unavailable; using the package guide', {
          tool: `${pinned.id}@${pinned.version}`, revision: pinned.guideOverride.revision,
        })
        continue
      }
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(join(dir, `${pinned.id}.md`), text, 'utf-8')
      copied.add(pinned.id)
    }
    return copied
  }

  /** How a tool signs in, as TOOLS.md and its skill state it. */
  private signInOf(toolId: string, record: CliToolVersionRecord | undefined): { text: string; enterprise: boolean } {
    if (!record || record.external) return { text: 'unknown', enterprise: false }
    const enterprise = sourceMayBind(record.source) && this.bindings.has(toolId)
    return { text: enterprise ? 'enterprise sign-in (provided by Halo)' : record.auth ?? 'unknown', enterprise }
  }

  /** Absolute path of a version's package guide, or null when it has none. */
  private packageGuidePath(record: CliToolVersionRecord): string | null {
    return record.guide && !record.external ? join(this.path(...record.dir.split('/')), ...record.guide.split('/')) : null
  }

  private async describeSkill(id: string, record: CliToolVersionRecord): Promise<CliToolSkillSummary> {
    let admin: string | undefined
    if (record.guideOverride) {
      const text = await fsp.readFile(this.path('guides', `${record.guideOverride.sha256}.md`), 'utf-8').catch(() => null)
      if (text !== null && sha256(text) === record.guideOverride.sha256) admin = splitGuide(text).description
      else this.log.error('[CliTools] Guide override unavailable; using the package description', { tool: id })
    }
    const packagePath = this.packageGuidePath(record)
    const head = packagePath && !admin ? await readGuideHead(packagePath) : null
    if (packagePath && !admin && !head) this.log.error('[CliTools] Package guide unreadable; using the manifest description', { tool: id })
    return {
      name: cliSkillName(id),
      ...resolveSkillDescription({
        admin,
        package: head ? splitGuide(head.text).description : undefined,
        manifest: record.description,
        toolName: record.name ?? id,
      }),
    }
  }

  /** Skill summaries for the management view, including disabled tools. */
  async describeToolSkills(state: CliToolState): Promise<Record<string, CliToolSkillSummary>> {
    const result: Record<string, CliToolSkillSummary> = {}
    for (const [id, tool] of Object.entries(state.tools)) {
      const record = tool.current ? tool.versions[tool.current] : undefined
      if (record?.commands.length) result[id] = await this.describeSkill(id, record)
    }
    return result
  }

  /** The agent-facing index of the pinned commands and where to read their guides. */
  private renderToolsGuide(lock: CliExecutionLock, state: CliToolState, viewDir: string, overridden: Set<string>): string {
    const lines = [
      '# Command-line tools in this session',
      '',
      'Run these commands from the launcher directory. Do not install, update or remove them yourself.',
      '',
      '| Command | Tool ID | Version | Side effects | Sign-in | Guide |',
      '|---|---|---|---|---|---|',
    ]
    let anyBound = false
    const blockedTools = new Set(lock.tools.filter(tool => tool.supportCheck === null).map(tool => tool.id))
    for (const command of lock.commands) {
      if (blockedTools.has(command.toolId)) continue
      const record = state.tools[command.toolId]?.versions[command.version]
      if (record?.external) {
        lines.push(`| \`${command.exposedAs}\` | ${command.toolId} | - | unknown | unknown | - |`)
        continue
      }
      const guide = overridden.has(command.toolId)
        ? join(viewDir, 'guides', `${command.toolId}.md`)
        : record?.guide ? join(this.path(...record.dir.split('/')), ...record.guide.split('/')) : ''
      const { text: signIn, enterprise } = this.signInOf(command.toolId, record)
      if (enterprise) anyBound = true
      lines.push(`| \`${command.exposedAs}\` | ${command.toolId} | ${command.version} | ${record?.sideEffects ?? 'unknown'} | ${signIn} | ${guide ? `\`${guide}\`` : '-'} |`)
    }
    if (blockedTools.size > 0) {
      lines.push('', 'Unavailable commands (do not run these or use a different program in their place):', '')
      for (const command of lock.commands) {
        if (blockedTools.has(command.toolId)) lines.push(`- \`${command.exposedAs}\` (${command.toolId})`)
      }
      lines.push('', SUPPORT_FAILURE)
    }
    if (anyBound) {
      lines.push(
        '',
        'A tool marked "enterprise sign-in" gets its credential from Halo while the user is signed in.',
        'If it reports that it is not signed in or not authorized, ask the user to sign in from the',
        'organization icon beside the send button, then run it again. Never ask for, print, store or pass a credential.',
      )
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
