/**
 * Keeping this device in step with the CLI catalog: when to read it, and the
 * delivery pass that installs the tools it marks `autoInstall`.
 *
 * Reads are asked for by events (startup, sign-in, window focus, wake, the
 * tools page) plus an hourly backstop; CliCatalogSchedule decides which of
 * them reach the network. The user's "Sync" ignores freshness. Every read
 * applies revocation, withdrawal, delisting and administrator texts (see
 * cli-catalog.ts), then delivers.
 *
 * Delivery picks, per tool, the highest listed version this device supports
 * and installs it when it is above every usable installed version, one tool
 * at a time. It never downgrades, except that a withdrawn current version
 * falls back to the highest remaining one (usually the copy shipped with
 * Halo). A current version the user imported or registered is left alone.
 * Partner tools are never installed here.
 *
 * Every tool's current preset or catalog version also follows its listed
 * bundle: when the catalog names a bundle this version has not taken (a new
 * skill, a new signing key, or a version installed before bundles), that
 * bundle is fetched and, its CLI content being the same, only the skill
 * changes. A bundle that fails its checks is remembered and not tried again
 * by background reads while the catalog lists the same bundle; the user's
 * "Sync" tries it once more. A network fault is retried at the next read.
 *
 * See DESIGN.md §3.13.
 */

import {
  EXTERNAL_VERSION,
  batchCurrentToolChanges,
  compareVersions,
  isCliToolError,
  readCliToolState,
  recordCliDeliveryFailure,
  setCliToolCurrent,
  type CliToolErrorCode,
  type CliToolRecord,
  type CliToolState,
} from '../../services/cli-tools'
import { STORE_NOT_SIGNED_IN } from '../../../shared/store/store-types'
import type { CliCatalogSyncResult } from '../../../shared/store/store-types'
import {
  applyStatus,
  downloadAndInstall,
  hasCliCatalogSource,
  loadCatalog,
  type CatalogToolRecord,
} from './cli-catalog'

export type CliCatalogTrigger = 'startup' | 'sign-in' | 'focus' | 'resume' | 'page' | 'backstop'

export const CLI_CATALOG_FRESH_MS = 15 * 60_000
export const CLI_CATALOG_RETRY_MS = 2 * 60_000
export const CLI_CATALOG_MAX_RETRY_MS = 60 * 60_000
const BACKSTOP_MS = 60 * 60_000
const BACKSTOP_JITTER_MS = 3 * 60_000

/** Package refusals that would repeat on every attempt; anything else is retried. */
const PERMANENT_REFUSALS = new Set<CliToolErrorCode>([
  'PACKAGE_INVALID', 'MANIFEST_INVALID', 'DIGEST_MISMATCH', 'PATH_UNSAFE', 'PLATFORM_UNSUPPORTED',
  'NATIVE_NOT_ALLOWED', 'RUNTIME_KIND_UNSUPPORTED', 'RUNTIME_VERSION_UNSUPPORTED', 'VERSION_CONFLICT',
  'SIGNATURE_MISSING', 'SIGNATURE_INVALID',
])

/**
 * When the next read is worth making. A successful read stays fresh for
 * CLI_CATALOG_FRESH_MS; a failed one backs off from CLI_CATALOG_RETRY_MS,
 * doubling up to CLI_CATALOG_MAX_RETRY_MS. With nobody signed in nothing was
 * asked of the server, so the next event may try again after the short wait.
 */
export class CliCatalogSchedule {
  private dueAt = 0
  private failures = 0

  constructor(private readonly now: () => number = Date.now) {}

  isDue(): boolean {
    return this.now() >= this.dueAt
  }

  succeeded(): void {
    this.failures = 0
    this.dueAt = this.now() + CLI_CATALOG_FRESH_MS
  }

  failed(): void {
    this.dueAt = this.now() + Math.min(CLI_CATALOG_RETRY_MS * 2 ** this.failures, CLI_CATALOG_MAX_RETRY_MS)
    this.failures += 1
  }

  signedOut(): void {
    this.dueAt = this.now() + CLI_CATALOG_RETRY_MS
  }
}

/** `realign` takes the listed bundle of the version already current. */
export type DeliveryStep = { action: 'install' | 'activate' | 'realign'; version: string }

function highest(versions: string[]): string | undefined {
  return [...versions].sort(compareVersions).pop()
}

type DeliveryFailures = CliToolState['deliveryFailures']

function refused(tool: CatalogToolRecord, entry: CatalogToolRecord['versions'][number], failures: DeliveryFailures): boolean {
  return failures?.[`${tool.id}@${entry.view.version}`]?.bundle === entry.bundle.sha256
}

/**
 * Whether the current version should take its listed bundle: it came from the
 * build or the catalog, the catalog still lists it, and the bundle differs
 * from the one it last took. Pure, exported for tests.
 */
export function planRealign(
  tool: CatalogToolRecord,
  installed: CliToolRecord | undefined,
  failures: DeliveryFailures,
): DeliveryStep | null {
  const version = installed?.current
  const record = version ? installed!.versions[version] : undefined
  if (!version || !record || (record.source !== 'preset' && record.source !== 'catalog')) return null
  const entry = tool.versions.find(v => v.view.version === version)
  if (!entry || refused(tool, entry, failures) || record.bundle?.sha256 === entry.bundle.sha256) return null
  return { action: 'realign', version }
}

/** What the delivery pass should do for one `autoInstall` tool; pure, exported for tests. */
export function planDelivery(
  tool: CatalogToolRecord,
  installed: CliToolRecord | undefined,
  failures: DeliveryFailures,
  nodeVersion: string,
): DeliveryStep | null {
  const candidates = tool.versions.filter(v =>
    v.view.supported &&
    (!v.view.minNode || compareVersions(nodeVersion, v.view.minNode) >= 0) &&
    !refused(tool, v, failures))
  const best = highest(candidates.map(v => v.view.version))
  if (!installed) return best ? { action: 'install', version: best } : null

  const current = installed.current ? installed.versions[installed.current] : undefined
  if (current && current.source !== 'preset' && current.source !== 'catalog') return null
  const usable = Object.entries(installed.versions)
    .filter(([version, r]) => version !== EXTERNAL_VERSION &&
      (r.source === 'preset' || (r.source === 'catalog' && !r.withdrawn)))
    .map(([version]) => version)
  const target = highest(best ? [...usable, best] : usable)
  if (!target) return null
  if (!installed.versions[target]) return { action: 'install', version: target }
  const fallBack = !current || (current.source === 'catalog' && current.withdrawn === true)
  if (fallBack && target !== installed.current) return { action: 'activate', version: target }
  return planRealign(tool, installed, failures)
}

function failureCode(error: unknown): CliToolErrorCode | null {
  return isCliToolError(error) && PERMANENT_REFUSALS.has(error.code) ? error.code : null
}

function describe(error: unknown): string {
  if (isCliToolError(error)) return error.code
  return error instanceof Error ? error.message : String(error)
}

async function deliver(
  tools: CatalogToolRecord[],
  state: CliToolState,
  result: CliCatalogSyncResult,
  retryRefused: boolean,
): Promise<void> {
  for (const tool of tools) {
    if (tool.revoked) continue
    const failures = retryRefused ? undefined : state.deliveryFailures
    // With every delivered version withdrawn the catalog drops the mark; the
    // device keeps it (applyCatalogStatus) so the fallback below still runs.
    const step = tool.autoInstall || state.tools[tool.id]?.autoInstall
      ? planDelivery(tool, state.tools[tool.id], failures, process.versions.node)
      : planRealign(tool, state.tools[tool.id], failures)
    if (!step) continue
    const label = `${tool.id}@${step.version}`
    try {
      if (step.action === 'activate') {
        await setCliToolCurrent(tool.id, step.version)
        console.log('[CliCatalog] Withdrawn version replaced', { tool: label })
        result.changed += 1
        continue
      }
      const entry = tool.versions.find(v => v.view.version === step.version)!
      await downloadAndInstall(entry)
      if (step.action === 'realign') {
        result.changed += 1
        console.log('[CliCatalog] Installed version took its current bundle', { tool: label, revision: entry.bundle.revision })
        continue
      }
      result.installed.push({ id: tool.id, version: step.version })
      console.log('[CliCatalog] Delivered version installed', { tool: label, revision: entry.bundle.revision })
    } catch (error) {
      result.failed.push({ id: tool.id, version: step.version })
      const code = failureCode(error)
      const entry = tool.versions.find(v => v.view.version === step.version)
      if (code && entry) await recordCliDeliveryFailure(tool.id, step.version, { bundle: entry.bundle.sha256, code })
      else console.warn('[CliCatalog] Delivered version not installed; retried at the next sync', { tool: label, reason: describe(error) })
    }
  }
}

async function syncOnce(retryRefused: boolean): Promise<CliCatalogSyncResult> {
  const result: CliCatalogSyncResult = { installed: [], failed: [], changed: 0, updates: 0 }
  const loaded = await loadCatalog()
  if (!loaded) return result
  const changed = new Set(loaded.changed)
  const before = await readCliToolState()
  if (!before) return result
  await deliver(loaded.tools, before, result, retryRefused)
  // New versions get their flags now, not at the next read.
  if (result.installed.length > 0) for (const id of await applyStatus(loaded.tools)) changed.add(id)
  for (const item of result.installed) changed.add(item.id)
  result.changed += changed.size
  const after = await readCliToolState()
  result.updates = Object.values(after?.tools ?? {}).filter(t => t.catalogUpdate && !t.autoInstall).length
  return result
}

const schedule = new CliCatalogSchedule()
let running: Promise<CliCatalogSyncResult> | null = null
let backstop: ReturnType<typeof setTimeout> | null = null

function run(retryRefused = false): Promise<CliCatalogSyncResult> {
  running ??= batchCurrentToolChanges(() => syncOnce(retryRefused))
    .then(result => {
      schedule.succeeded()
      return result
    }, (error: unknown) => {
      if (error instanceof Error && error.message === STORE_NOT_SIGNED_IN) schedule.signedOut()
      else schedule.failed()
      throw error
    })
    .finally(() => {
      running = null
    })
  return running
}

/**
 * Read the catalog now if it is due (sign-in always is). Null when nothing
 * was read: no catalog source, still fresh, or nobody signed in. Never throws;
 * failures are logged and back off.
 */
export async function requestCliCatalogSync(trigger: CliCatalogTrigger): Promise<CliCatalogSyncResult | null> {
  if (!hasCliCatalogSource()) return null
  if (!running && trigger !== 'sign-in' && !schedule.isDue()) return null
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof Error && error.message === STORE_NOT_SIGNED_IN)) {
      console.warn('[CliCatalog] Sync failed; installed tools unchanged', { trigger, reason: describe(error) })
    }
    return null
  }
}

/**
 * The user's "Sync": reads the catalog regardless of freshness, tries refused
 * deliveries once more (a corrupted transfer looks like a bad package), and
 * reports the outcome, or throws.
 */
export async function syncCliCatalogNow(): Promise<CliCatalogSyncResult> {
  if (!hasCliCatalogSource()) return { installed: [], failed: [], changed: 0, updates: 0 }
  while (running) await running.catch(() => undefined)
  return run(true)
}

/**
 * Arm the hourly backstop for machines whose window rarely gains focus, such
 * as one that only runs scheduled digital humans. Returns the stop function.
 */
export function startCliCatalogBackstop(): () => void {
  const arm = (): void => {
    const delay = BACKSTOP_MS + Math.round((Math.random() * 2 - 1) * BACKSTOP_JITTER_MS)
    backstop = setTimeout(() => {
      void requestCliCatalogSync('backstop')
      arm()
    }, delay)
    backstop.unref?.()
  }
  if (!backstop) arm()
  return () => {
    if (backstop) clearTimeout(backstop)
    backstop = null
  }
}
