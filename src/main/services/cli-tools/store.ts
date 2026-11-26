/**
 * The CLI tool store: installed versions, the current choice per tool, and the
 * launchers that run the current version of each usable tool. See DESIGN.md.
 *
 * Layout under `root` (the caller passes e.g. `<userData>/cli`):
 *
 *   store/<id>/<version>-<digest12>/   immutable, read-only installed package
 *   support/<id>/<version>-<digest12>/<supportDigest>/    immutable runtime variants
 *   staging/<txid>/                    one import transaction; removed on exit
 *   skills/<sha256>/                   skills delivered in bundles, by content (read-only)
 *   tools/<id>/bin/                    launchers for the tool's current version
 *   tools/<id>/install.json            that installation: its id, launchers and skill
 *   tools/<id>/*.cjs                   preloads the launchers load (see shims.ts)
 *   state.json                         versions, current choice, revocation
 *
 * The module is pure Node and takes every environment fact as a parameter
 * (root, runtime path, runtime version, platform), so it imports no Electron
 * or agent code and starts no work on its own.
 */

import { createHash, randomBytes, randomUUID } from 'crypto'
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
import { BUNDLE_SKILL_MAIN_MAX_BYTES, skillPackageSha256, type BundleSkillSource, type VerifiedBundle } from './bundle'
import {
  assertRealDirectories, assertSupportFiles, BASE_SUPPORT_FILE, copyPackageTree, loadSupportFiles,
  placeSupportFiles, renderSupportPreload, supportDigest, supportError, supportExpectations,
  supportPathExists, type CliSupportFilesConfig, type SupportCheck,
} from './support-files'
import {
  cliSkillDescription,
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
   * The delivery bundle revision this version last took (preset and catalog
   * versions only). A version installed before bundles has none, and takes
   * the next bundle of the same content without a reinstall.
   */
  bundle?: { revision: number; sha256: string }
  /**
   * The skill that bundle carried (`skills/<sha256>/`); absent when it carried
   * none, and then the package guide applies.
   */
  skill?: { sha256: string; files: number; source: BundleSkillSource }
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
  /**
   * This tool's installation on this device, set when it first becomes usable
   * and kept across version changes; removing the tool drops it. Part of the
   * skill's name, so installations sharing a skill folder never touch each
   * other's skill.
   */
  installId?: string
  versions: Record<string, CliToolVersionRecord>
}

/** A delivered bundle this device refused; not tried again while the catalog lists the same bundle. */
export interface CliDeliveryFailure {
  /** sha256 of the refused bundle. */
  bundle: string
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
   * command started earlier in that process could still be running them;
   * deleted by `collectPendingCleanup` at the next start.
   */
  pendingCleanup?: string[]
  /** Keyed `id@version`; dropped once the catalog stops listing that bundle. */
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

/** Catalog facts about one tool, as `applyCatalogStatus` consumes them. */
export interface CatalogToolStatus {
  id: string
  revoked: boolean
  /** The catalog delivers this tool to every device (see `CliToolRecord.autoInstall`). */
  autoInstall?: boolean
  /** Approved versions the catalog lists now, with the sha256 of each one's current bundle. */
  versions: Record<string, string>
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
  /**
   * The verified delivery bundle the archive came from. Its revision and
   * skill are recorded on the version, also when identical content is
   * already installed, which then needs no reinstall.
   */
  bundle?: Pick<VerifiedBundle, 'revision' | 'sha256' | 'skill'>
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

/** `tools/<id>/install.json`: one usable tool's launchers and where its skill went. */
export interface CliToolInstallRecord {
  schema: 1
  toolId: string
  installId: string
  version: string
  integrity: string
  /** Digest of everything the launchers were written from; a different one rewrites them. */
  launchKey: string
  commands: Array<{ name: string; launcher: string; cmdLauncher?: string }>
  /** The skill file the host installed for this installation; absent until it exists. */
  skill?: { name: string; path: string }
}

/** The support files a version runs with: which copy, and the check its launchers make. */
interface SupportSelection {
  supportDigest?: string
  supportVariant?: true
  supportCheck?: SupportCheck | null
}

interface LauncherTarget {
  command: string
  entry: string
  direct?: true
  fingerprint?: string
  credential?: CliCredentialBinding
  supportDigest?: string
  supportCheck?: SupportCheck | null
}

export { GUIDE_MAX_BYTES } from './skills'

const STATE_MAX_BYTES = 1024 * 1024
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
    if (entry?.versions[version] !== undefined && entry.versions[version] === failure.bundle) continue
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
/** Bumped when launcher layout or skill text changes, so every tool gets new ones. */
const LAUNCH_FORMAT = 1

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
    return record.commands.length > 0 ? [{ id, tool, version: tool.current!, record }] : []
  })
}

function toolSkillFingerprint(tool: CliToolRecord, record: CliToolVersionRecord): string {
  return sha256(JSON.stringify([
    LAUNCH_FORMAT, tool.installId, record.integrity, record.skill?.sha256, record.name, record.description,
    record.commands.map(command => command.name),
  ]))
}

function currentToolsRevision(state: CliToolState): string {
  return sha256(JSON.stringify(currentToolRecords(state).map(({ id, tool, version, record }) => [
    id, version, toolSkillFingerprint(tool, record), record.external?.sha256,
  ])))
}

/**
 * Earlier builds recorded catalog guide texts per version; skills now arrive
 * in bundles, so those records go. True when any was dropped.
 */
function dropLegacyGuideFields(state: CliToolState): boolean {
  let dropped = false
  for (const tool of Object.values(state.tools)) {
    for (const record of Object.values(tool.versions) as Array<CliToolVersionRecord & Record<string, unknown>>) {
      for (const key of ['guideOverride', 'liveGuideSeen']) {
        if (!(key in record)) continue
        delete record[key]
        dropped = true
      }
    }
  }
  return dropped
}

/** Give every usable tool an installation id; true when one was added. */
function assignInstallIds(state: CliToolState): boolean {
  let added = false
  for (const { tool } of currentToolRecords(state)) {
    if (tool.installId) continue
    tool.installId = randomBytes(3).toString('hex')
    added = true
  }
  return added
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

/** Read a whole guide, up to the administrator guide limit. */
async function readGuide(path: string): Promise<string | null> {
  let handle: fsp.FileHandle | null = null
  try {
    handle = await fsp.open(path, 'r')
    const buffer = Buffer.alloc(GUIDE_MAX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, GUIDE_MAX_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8').replace(/\uFFFD+$/, '')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

const SKILL_TREE_MAX_FILES = 2000
const SKILL_TREE_MAX_BYTES = 32 * 1024 * 1024

/** Read a stored skill directory: regular files only, within the bundle limits. */
async function readSkillTree(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  let total = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, path)
        continue
      }
      if (!entry.isFile()) throw new Error('skill tree holds something other than files')
      const bytes = await fsp.readFile(full)
      total += bytes.byteLength
      if (files.size >= SKILL_TREE_MAX_FILES || total > SKILL_TREE_MAX_BYTES) throw new Error('skill tree exceeds its limits')
      files.set(path, bytes)
    }
  }
  await walk(root, '')
  return files
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
  /** Store directories this process has given launchers; a command may still run from them. */
  private readonly launched = new Set<string>()
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

  /**
   * Persist state. A changed usable set also rewrites the launchers before
   * anyone is told, so a skill is never published for a launcher that is not
   * there yet; `syncLaunchers` forces that rewrite.
   */
  private async writeState(state: CliToolState, syncLaunchers = false): Promise<void> {
    assignInstallIds(state)
    const previous = state.currentToolsRevision ?? this.currentRevision
    const previousFingerprint = state.currentToolsFingerprint ?? this.currentFingerprint
    const fingerprint = currentToolsRevision(state)
    const revision = previousFingerprint === fingerprint ? previous ?? fingerprint : randomUUID()
    state.currentToolsRevision = revision
    state.currentToolsFingerprint = fingerprint
    await fsp.mkdir(this.root, { recursive: true })
    await writeFileAtomic(this.path('state.json'), `${JSON.stringify(state, null, 2)}\n`)
    this.currentRevision = revision
    this.currentFingerprint = fingerprint
    if (syncLaunchers || previousFingerprint !== fingerprint) await this.syncLaunchersLocked(state)
    if (revision !== previous) this.currentToolsChanged.fire(revision)
  }

  /**
   * The skill of each usable tool. Fingerprints let a caller read guides only
   * for tools whose skill inputs changed.
   */
  readCurrentToolSkills() {
    return this.serialize(async () => {
      const state = await this.readState()
      const tools = currentToolRecords(state).filter(({ tool }) => tool.installId)
      return {
        revision: state.currentToolsRevision ?? currentToolsRevision(state),
        skills: tools.map(({ id, tool, record }) => ({
          toolId: id,
          fingerprint: toolSkillFingerprint(tool, record),
          describe: () => this.renderToolSkill(id, tool.installId!, record),
        })),
      }
    })
  }

  /** Absolute launcher path of one command of a usable tool. */
  launcherPath(toolId: string, command: string, shell: 'sh' | 'cmd' = 'sh'): string {
    return this.path('tools', toolId, 'bin', shell === 'cmd' ? `${command}.cmd` : command)
  }

  private async renderToolSkill(id: string, installId: string, record: CliToolVersionRecord): Promise<CliToolSkill> {
    const command = record.commands[0].name
    const bundled = await this.readBundleSkill(id, record)
    const attachments: CliToolSkill['attachments'] = []
    let text: string | null = null
    let description: { description: string }
    if (bundled) {
      text = bundled.get('SKILL.md')!.toString('utf-8')
      for (const [path, bytes] of bundled) if (path !== 'SKILL.md') attachments.push({ path, bytes })
      description = resolveSkillDescription({
        admin: splitGuide(text).description,
        manifest: record.description,
        toolName: record.name ?? id,
      })
    } else {
      const packagePath = this.packageGuidePath(record)
      if (packagePath) {
        text = await readGuide(packagePath)
        if (text === null) this.log.error('[CliTools] Package guide unreadable; the skill names only the tool', { tool: id })
      }
      description = resolveSkillDescription({
        package: text === null ? undefined : splitGuide(text).description,
        manifest: record.description,
        toolName: record.name ?? id,
      })
    }
    return {
      toolId: id,
      installId,
      name: cliSkillName(command, id, installId),
      description: cliSkillDescription(command, description.description),
      attachments,
      body: renderCliSkill({
        toolId: id,
        installId,
        launches: record.commands.map(({ name }) => ({
          command: name,
          path: this.launcherPath(id, name),
          ...(this.platform === 'win32' ? { cmdPath: this.launcherPath(id, name, 'cmd') } : {}),
        })),
        guide: text === null ? undefined : splitGuide(text).body,
      }),
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

  private async selectSupport(record: CliToolVersionRecord): Promise<SupportSelection> {
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
          name: cliSkillName(manifest.commands[0]?.name ?? manifest.id, manifest.id, ''),
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
        stage = 'bundle'
        const bundleChanged = options.bundle ? await this.applyBundle(label, existing, options.bundle) : false
        if (bundleChanged) this.dropDeliveryFailure(state, label)
        if (activate && tool.current !== manifest.version) tool.current = manifest.version
        if (bundleChanged || previous !== tool.current) await this.writeState(state)
        if (bundleChanged) await this.pruneSkills(state)
        this.log.log('[CliTools] Import matched an installed version', {
          tool: label, current: tool.current, ...(options.bundle ? { revision: options.bundle.revision, skillChanged: bundleChanged } : {}),
        })
        return {
          id: manifest.id, version: manifest.version, integrity: inspection.integrity,
          installed: false, current: tool.current, previous,
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
      stage = 'bundle'
      if (options.bundle) await this.applyBundle(label, tool.versions[manifest.version], options.bundle)
      // Reinstalling content a pending cleanup still lists must not lose it later.
      if (state.pendingCleanup) {
        state.pendingCleanup = state.pendingCleanup.filter(d => d !== dirRel)
        if (state.pendingCleanup.length === 0) delete state.pendingCleanup
      }
      // The offered update is now installed (or overtaken): stop offering it until the next catalog read.
      if (tool.catalogUpdate && compareVersions(manifest.version, tool.catalogUpdate) >= 0) delete tool.catalogUpdate
      this.dropDeliveryFailure(state, label)
      if (activate || tool.current === null) tool.current = manifest.version
      state.tools[manifest.id] = tool
      stage = 'state'
      await this.writeState(state)
      published = null
      if (options.bundle) await this.pruneSkills(state)

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

  private dropDeliveryFailure(state: CliToolState, label: string): void {
    if (!state.deliveryFailures?.[label]) return
    delete state.deliveryFailures[label]
    if (Object.keys(state.deliveryFailures).length === 0) delete state.deliveryFailures
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
   * Write `state` (whose records no longer name `victims`), which also takes
   * away their launchers, then delete the victims' store directories. One this
   * process gave launchers to may still run a command, so it waits in
   * `pendingCleanup` for the next start, as does one that cannot be deleted
   * now. State is written first: a crash afterwards leaves an orphan
   * directory, never a record pointing at deleted files.
   */
  private async dropFiles(
    state: CliToolState,
    victims: Array<{ id: string; version: string; record: CliToolVersionRecord }>,
  ): Promise<string[]> {
    const now: string[] = []
    const deferred: string[] = []
    for (const { record } of victims) {
      if (record.external || !record.dir) continue
      if (this.launched.has(record.dir)) deferred.push(record.dir)
      else now.push(record.dir)
    }
    if (deferred.length > 0) {
      state.pendingCleanup = [...new Set([...(state.pendingCleanup ?? []), ...deferred])]
    }
    await this.writeState(state)
    const failed: string[] = []
    for (const rel of now) {
      try {
        await this.deleteVersionDirs(rel)
      } catch (err) {
        failed.push(rel)
        this.log.error('[CliTools] Removed version could not be deleted now; retrying at the next start', {
          dir: rel, code: (err as NodeJS.ErrnoException).code,
        })
      }
    }
    if (failed.length > 0) {
      state.pendingCleanup = [...new Set([...(state.pendingCleanup ?? []), ...failed])]
      await this.writeState(state)
    }
    return [...deferred, ...failed]
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
   * Delete directories waiting in `pendingCleanup` that no record refers to
   * any more. Run at the start of a process, before it gives out launchers.
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
      const keep: string[] = []
      let removed = 0
      for (const rel of pending) {
        if (recorded.has(rel)) continue
        try {
          await this.deleteVersionDirs(rel)
          removed += 1
        } catch (err) {
          keep.push(rel)
          this.log.error('[CliTools] Removed version still cannot be deleted', { dir: rel, code: (err as NodeJS.ErrnoException).code })
        }
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
   * Check the current registered programs: size and mtime first, the hash
   * only when they moved. A missing or different file is marked changed (and
   * so loses its launcher); an identical one just refreshes its stamp.
   * Returns true when `state` changed; the caller writes it.
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
    return dirty
  }

  // ── catalog status ───────────────────────────────────────────────────

  /**
   * Apply what a freshly read administrator catalog says. For every listed
   * tool: its revocation flag (any source). For tools with catalog-sourced
   * versions: `delisted` when the catalog has neither an approved version
   * nor a revocation entry for it, `withdrawn` per version the catalog no
   * longer lists, and `catalogUpdate` when an approved version is above
   * every installed one. A delivered tool whose versions are all withdrawn
   * stays listed, so it is not delisted. Skills arrive only with bundles, so
   * nothing here changes one. Nothing is downloaded. Returns the ids that
   * changed.
   */
  applyCatalogStatus(catalog: CatalogToolStatus[]): Promise<string[]> {
    return this.serialize(async () => {
      const state = await this.readState()
      const byId = new Map(catalog.map(t => [t.id, t]))
      const changed: string[] = []
      for (const [id, tool] of Object.entries(state.tools)) {
        const before = JSON.stringify(tool)
        const entry = byId.get(id)
        const listed = entry ? Object.keys(entry.versions) : []
        if (entry) tool.revoked = entry.revoked
        // An entry without versions does not carry the flag, so it keeps the last one seen.
        if (entry?.autoInstall) tool.autoInstall = true
        else if (!entry || listed.length > 0) delete tool.autoInstall
        const catalogVersions = Object.entries(tool.versions).filter(([, v]) => v.source === 'catalog')
        if (catalogVersions.length > 0) {
          const gone = !entry || (!entry.revoked && listed.length === 0 && !tool.autoInstall)
          if (gone) tool.delisted = true
          else delete tool.delisted
          for (const [version, record] of catalogVersions) {
            if (entry && !listed.includes(version)) record.withdrawn = true
            else delete record.withdrawn
          }
        }
        const installed = Object.keys(tool.versions).filter(v => v !== EXTERNAL_VERSION)
        const best = entry && !entry.revoked
          ? [...listed].sort(compareVersions).pop()
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
      await this.pruneSkills(state)
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

  /** Re-hash an installed version and compare it with its recorded integrity. */
  async verifyVersion(id: string, version: string): Promise<boolean> {
    const record = (await this.readState()).tools[id]?.versions[version]
    if (!record) throw new CliToolError('NOT_FOUND', `${id}@${version} is not installed`)
    const files = await scanPayload(this.path(...record.dir.split('/'), 'payload'), false)
    const ok = integrityOf(files) === record.integrity
    if (!ok) this.log.error('[CliTools] Installed version no longer matches its integrity', { tool: `${id}@${version}` })
    return ok
  }

  // ── launchers ────────────────────────────────────────────────────────

  /**
   * Bring `tools/` in line with state once per process: re-check registered
   * programs, give usable tools an installation id, and rewrite launchers a
   * moved runtime or changed support files made stale. Later changes keep the
   * launchers current through `writeState`.
   */
  syncLaunchers(): Promise<void> {
    return this.serialize(async () => {
      await this.removeLegacyViews()
      const state = await this.readState()
      const legacy = dropLegacyGuideFields(state)
      const changed = await this.checkExternals(state) || legacy
      if (changed || currentToolRecords(state).some(({ tool }) => !tool.installId)) await this.writeState(state, true)
      else await this.syncLaunchersLocked(state)
    })
  }

  /** Earlier builds kept per-session command views, pins and catalog guide texts; nothing reads them now. */
  private async removeLegacyViews(): Promise<void> {
    for (const name of ['views', 'locks', 'guides']) {
      if (existsSync(this.path(name))) await fsp.rm(this.path(name), { recursive: true, force: true })
    }
  }

  /** Store directories this process gave launchers to (see `CliToolView.inUse`). */
  launchedDirs(): ReadonlySet<string> {
    return new Set(this.launched)
  }

  /** The installation record of a tool's launchers, or null when it has none. */
  async readInstallRecord(toolId: string): Promise<CliToolInstallRecord | null> {
    try {
      const record = JSON.parse(await fsp.readFile(this.path('tools', toolId, 'install.json'), 'utf-8')) as CliToolInstallRecord
      return record?.schema === 1 && record.toolId === toolId && typeof record.installId === 'string' ? record : null
    } catch {
      return null
    }
  }

  /**
   * Record where the skill of one installation went (or that it has none), in
   * that installation's own record. Ignored when the tool was reinstalled since.
   */
  recordSkillLocation(toolId: string, installId: string, skill: { name: string; path: string } | null): Promise<boolean> {
    return this.serialize(async () => {
      const record = await this.readInstallRecord(toolId)
      if (!record || record.installId !== installId) return false
      if (JSON.stringify(record.skill ?? null) === JSON.stringify(skill)) return true
      const next: CliToolInstallRecord = { ...record }
      if (skill) next.skill = skill
      else delete next.skill
      await writeFileAtomic(this.path('tools', toolId, 'install.json'), `${JSON.stringify(next, null, 2)}\n`)
      return true
    })
  }

  /**
   * Write launchers for the current version of every usable tool and remove
   * those of every other tool. A tool whose launchers cannot be written keeps
   * the ones it had; the failure is logged and the next change retries.
   */
  private async syncLaunchersLocked(state: CliToolState): Promise<void> {
    if (!existsSync(this.runtimePath)) {
      this.log.error('[CliTools] Runtime executable is missing; launchers left as they are')
      return
    }
    const wanted = new Set<string>()
    let invalidDeployment = false
    for (const { id, tool, record } of currentToolRecords(state)) {
      if (!tool.installId) continue
      wanted.add(id)
      try {
        let support: SupportSelection = {}
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
        const targets = this.launcherTargets(id, record, support)
        const launchKey = sha256(JSON.stringify({
          v: LAUNCH_FORMAT, platform: this.platform, runtime: this.runtimePath, installId: tool.installId,
          version: tool.current, integrity: record.integrity, targets,
        }))
        const existing = await this.readInstallRecord(id)
        if (existing?.launchKey !== launchKey) {
          await this.writeToolLaunchers(id, tool.installId, tool.current!, record, targets, launchKey, existing)
        }
        if (record.dir) this.launched.add(record.dir)
      } catch (err) {
        this.log.error('[CliTools] Launchers could not be written; the tool keeps its earlier ones', {
          tool: id,
          code: isCliToolError(err) ? err.code : (err as NodeJS.ErrnoException).code ?? 'UNEXPECTED',
        })
      }
    }
    let names: string[] = []
    try {
      names = await fsp.readdir(this.path('tools'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    for (const name of names) {
      if (wanted.has(name)) continue
      try {
        await fsp.rm(this.path('tools', name), { recursive: true, force: true })
        if (!name.startsWith('.')) this.log.log('[CliTools] Launchers removed', { tool: name })
      } catch (err) {
        this.log.error('[CliTools] Launchers could not be removed now; retrying on the next change', {
          tool: name, code: (err as NodeJS.ErrnoException).code,
        })
      }
    }
  }

  private launcherTargets(id: string, record: CliToolVersionRecord, support: SupportSelection): LauncherTarget[] {
    if (record.external) {
      const external = record.external
      return record.commands.map(command => ({
        command: command.name,
        entry: external.path,
        ...(external.interpreter === null ? { direct: true as const } : {}),
        fingerprint: external.sha256,
      }))
    }
    const credential = sourceMayBind(record.source) ? this.bindings.get(id) : undefined
    const { supportDigest, supportCheck, supportVariant } = support
    const dir = supportVariant && supportDigest && /^[0-9a-f]{64}$/.test(supportDigest)
      ? `${this.variantParent(record.dir)}/${supportDigest}` : record.dir
    return record.commands.map(command => ({
      command: command.name,
      entry: supportCheck === null ? '' : join(supportCheck?.root ??
        join(supportDigest ? this.canonicalRoot ?? this.root : this.root, dir), 'payload', command.entry),
      ...(credential && supportCheck !== null ? { credential } : {}),
      ...(supportDigest ? { supportDigest } : {}),
      ...(supportCheck !== undefined ? { supportCheck } : {}),
    }))
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
   * Build a tool's launcher directory beside the live one and swap it in, so
   * a command started meanwhile finds either the old set or the new one, never
   * half of each. The skill location carries over within one installation.
   */
  private async writeToolLaunchers(
    id: string,
    installId: string,
    version: string,
    record: CliToolVersionRecord,
    targets: LauncherTarget[],
    launchKey: string,
    existing: CliToolInstallRecord | null,
  ): Promise<void> {
    const dir = this.path('tools', id)
    const binDir = join(dir, 'bin')
    const tmp = this.path('tools', `.tmp-${randomUUID()}`)
    const old = this.path('tools', `.old-${randomUUID()}`)
    try {
      await fsp.mkdir(join(tmp, 'bin'), { recursive: true })
      // Launchers name their preloads by final path, where the directory lands after the swap.
      await fsp.writeFile(join(tmp, ARGV_PRELOAD_FILE), renderArgvPreload(), 'utf-8')
      const preloadPath = join(dir, ARGV_PRELOAD_FILE)
      const runtimePath = await this.launcherRuntimePath()
      for (const [index, target] of targets.entries()) {
        let supportPreloadPath: string | undefined
        if (target.supportCheck !== undefined) {
          const file = `support-${index}.cjs`
          await fsp.writeFile(join(tmp, file), renderSupportPreload(target.supportCheck), 'utf-8')
          supportPreloadPath = join(dir, file)
        }
        let credentialPreloadPath: string | undefined
        if (target.credential) {
          const file = credentialPreloadFile(index)
          await fsp.writeFile(join(tmp, file), renderCredentialPreload(target.credential), 'utf-8')
          credentialPreloadPath = join(dir, file)
        }
        const paths = {
          runtimePath, preloadPath, supportPreloadPath, credentialPreloadPath, binDir,
          entryPath: target.supportCheck === null ? supportPreloadPath! : target.entry,
          direct: target.direct === true,
        }
        for (const file of launcherFiles(this.platform, target.command, paths)) {
          await fsp.writeFile(join(tmp, 'bin', file.name), file.content, { encoding: 'utf-8', mode: file.executable ? 0o755 : 0o644 })
        }
      }
      const install: CliToolInstallRecord = {
        schema: 1,
        toolId: id,
        installId,
        version,
        integrity: record.integrity,
        launchKey,
        commands: targets.map(({ command }) => ({
          name: command,
          launcher: this.launcherPath(id, command),
          ...(this.platform === 'win32' ? { cmdLauncher: this.launcherPath(id, command, 'cmd') } : {}),
        })),
        ...(existing?.installId === installId && existing.skill ? { skill: existing.skill } : {}),
      }
      await fsp.writeFile(join(tmp, 'install.json'), `${JSON.stringify(install, null, 2)}\n`, 'utf-8')
      const replacing = existsSync(dir)
      if (replacing) await fsp.rename(dir, old)
      try {
        await fsp.rename(tmp, dir)
      } catch (err) {
        if (replacing) await fsp.rename(old, dir).catch(() => undefined)
        throw err
      }
      if (replacing) await fsp.rm(old, { recursive: true, force: true }).catch(() => undefined)
      this.log.log('[CliTools] Launchers written', { tool: id, version, commands: targets.length })
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Absolute path of a version's package guide, or null when it has none. */
  private packageGuidePath(record: CliToolVersionRecord): string | null {
    return record.guide && !record.external ? join(this.path(...record.dir.split('/')), ...record.guide.split('/')) : null
  }

  /** A version's bundle skill files, checked against their digest; null when it has none or they do not check out. */
  private async readBundleSkill(id: string, record: CliToolVersionRecord): Promise<Map<string, Buffer> | null> {
    if (!record.skill) return null
    try {
      const files = await readSkillTree(this.path('skills', record.skill.sha256))
      const main = files.get('SKILL.md')
      if (main && main.byteLength <= BUNDLE_SKILL_MAIN_MAX_BYTES && files.size === record.skill.files &&
        skillPackageSha256(files) === record.skill.sha256) return files
    } catch {
      // Reported below; the package guide stands in.
    }
    this.log.error('[CliTools] Bundle skill unavailable; using the package guide', { tool: id })
    return null
  }

  /**
   * Keep a bundle's skill as `skills/<sha256>/`, written once per content
   * through staging and left read-only. An existing copy is re-checked and
   * replaced only when it no longer matches.
   */
  private async storeSkillFiles(skill: NonNullable<VerifiedBundle['skill']>): Promise<void> {
    const target = this.path('skills', skill.sha256)
    if (existsSync(target)) {
      const current = await readSkillTree(target).catch(() => null)
      if (current && current.size === skill.files.size && skillPackageSha256(current) === skill.sha256) return
      await setTreeReadOnly(target, false, this.platform).catch(() => undefined)
      await fsp.rm(target, { recursive: true, force: true })
    }
    const staging = this.path('staging', `skill-${randomUUID()}`)
    try {
      for (const [path, bytes] of skill.files) {
        const file = join(staging, ...path.split('/'))
        await fsp.mkdir(dirname(file), { recursive: true })
        await fsp.writeFile(file, bytes, { flag: 'wx', mode: 0o644 })
      }
      await fsp.mkdir(this.path('skills'), { recursive: true })
      await fsp.rename(staging, target)
      await setTreeReadOnly(target, true, this.platform)
    } finally {
      if (existsSync(staging)) {
        await setTreeReadOnly(staging, false, this.platform).catch(() => undefined)
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  /** Delete stored skills no version record refers to. */
  private async pruneSkills(state: CliToolState): Promise<void> {
    let names: string[]
    try {
      names = await fsp.readdir(this.path('skills'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const referenced = new Set<string>()
    for (const tool of Object.values(state.tools)) {
      for (const record of Object.values(tool.versions)) if (record.skill) referenced.add(record.skill.sha256)
    }
    for (const name of names) {
      if (referenced.has(name)) continue
      const dir = this.path('skills', name)
      await setTreeReadOnly(dir, false, this.platform).catch(() => undefined)
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Record a verified bundle on a preset or catalog version: its revision,
   * and its skill (stored first) or none. True when the record changed.
   */
  private async applyBundle(label: string, record: CliToolVersionRecord, bundle: NonNullable<ImportOptions['bundle']>): Promise<boolean> {
    if (record.source !== 'preset' && record.source !== 'catalog') {
      this.log.log('[CliTools] Bundle skill not applied to a version the user installed', { tool: label })
      return false
    }
    if (bundle.skill) await this.storeSkillFiles(bundle.skill)
    const before = JSON.stringify([record.bundle, record.skill])
    record.bundle = { revision: bundle.revision, sha256: bundle.sha256 }
    if (bundle.skill) record.skill = { sha256: bundle.skill.sha256, files: bundle.skill.files.size, source: bundle.skill.source }
    else delete record.skill
    return JSON.stringify([record.bundle, record.skill]) !== before
  }

  private async describeSkill(id: string, record: CliToolVersionRecord, installId = ''): Promise<CliToolSkillSummary> {
    let bundled: string | undefined
    if (record.skill) {
      const head = await readGuideHead(this.path('skills', record.skill.sha256, 'SKILL.md'))
      if (head) bundled = splitGuide(head.text).description
      else this.log.error('[CliTools] Bundle skill unreadable; using the package description', { tool: id })
    }
    const fromPackageGuide = record.skill?.source === 'package-guide'
    const packagePath = this.packageGuidePath(record)
    const head = packagePath && !bundled ? await readGuideHead(packagePath) : null
    if (packagePath && !bundled && !head) this.log.error('[CliTools] Package guide unreadable; using the manifest description', { tool: id })
    return {
      name: cliSkillName(record.commands[0]?.name ?? id, id, installId),
      ...resolveSkillDescription({
        admin: fromPackageGuide ? undefined : bundled,
        package: fromPackageGuide ? bundled : head ? splitGuide(head.text).description : undefined,
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
      if (record?.commands.length) result[id] = await this.describeSkill(id, record, tool.installId)
    }
    return result
  }
}
