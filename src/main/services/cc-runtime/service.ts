import { getConfig, saveConfig } from '../../foundation/config.service'
import { DEFAULT_MAX_TURNS } from '../../../shared/constants/agent-limits'
import type { CcInstallation, CcInstallProgress, CcInstallRequest, CcReleaseInfo, CcRuntimeConfig, CcRuntimePreferences, CcRuntimeStatus } from '../../../shared/types/cc-runtime'
import { getCatalogEntry, getCatalogSnapshot, getManagedCatalogEntries, mergeInstallationSnapshot, rememberInstallation } from './catalog'
import { discoverInstallations } from './discovery'
import { CcRuntimeError, issueFromError } from './errors'
import { downloadAndPublish } from './installer'
import { checkInstallation, launchForInstallation, readKnownInstallation, shutdownProbes } from './probe'
import { getSources, isInstallVersion, validatePreferences } from './sources'
import { RECOMMENDED_RANGE, RECOMMENDED_VERSION, getVerifiedVersionsForPlatform } from './policy'
import { clearReleaseCache, lookupRelease } from './releases'
import { reuseManagedInstallation } from './reuse'

let installController: AbortController | undefined
let installProgress: CcInstallProgress = { phase: 'idle', downloadedBytes: 0 }
let selectionRevision = 0
let installFinished: Promise<void> | undefined

function readConfig(): CcRuntimeConfig {
  return getConfig().agent?.ccRuntime || {}
}

function persistConfig(patch: Partial<CcRuntimeConfig>): void {
  const next = { ...readConfig(), ...patch }
  const agent = getConfig().agent
  saveConfig({ agent: { ...agent, maxTurns: agent?.maxTurns ?? DEFAULT_MAX_TURNS, ccRuntime: next } })
  if (JSON.stringify(readConfig()) !== JSON.stringify(next)) throw new CcRuntimeError('storage-failed')
}

export async function getCcRuntimeStatus(): Promise<CcRuntimeStatus> {
  const config = readConfig()
  const catalog = await getCatalogSnapshot()
  const installations = catalog.installations.map(item => {
    const known = readKnownInstallation(item.path)
    return known?.checkedAt && (!item.checkedAt || known.checkedAt > item.checkedAt) ? mergeInstallationSnapshot(item, known) : item
  })
  return {
    selectedPath: config.selectedPath,
    selected: config.selectedPath ? installations.find(item => item.path === config.selectedPath) ?? readKnownInstallation(config.selectedPath) : null,
    installations, catalogTruncated: catalog.truncated,
    sources: getSources(config), sourceId: config.sourceId || 'official',
    installVersion: config.installVersion || RECOMMENDED_VERSION,
    recommendedVersion: RECOMMENDED_VERSION,
    recommendedRange: RECOMMENDED_RANGE, verifiedVersions: getVerifiedVersionsForPlatform(),
    install: { ...installProgress }
  }
}

export async function configureCcRuntime(preferences: CcRuntimePreferences): Promise<CcRuntimeStatus> {
  try {
    const current = readConfig()
    const next = validatePreferences({ sources: current.sources, sourceId: current.sourceId, installVersion: current.installVersion, ...preferences })
    persistConfig(next)
    return getCcRuntimeStatus()
  } catch (error) {
    console.warn('[CcRuntime] Preferences could not be saved', { issue: issueFromError(error, 'storage-failed') })
    throw error
  }
}

export function scanCcInstallations() {
  return discoverInstallations(readConfig().selectedPath, { deadlineMs: 12_000 })
}

export async function probeCcInstallation(path: string): Promise<CcInstallation> {
  const result = await checkInstallation(path, { force: true })
  if (['verified', 'compatible'].includes(result.compatibility) || (await getCatalogSnapshot()).installations.some(item => item.path === result.path)) {
    await rememberInstallation(result)
  }
  return result
}

export async function lookupCcRelease(request: CcInstallRequest = {}): Promise<CcReleaseInfo> {
  const config = readConfig()
  const source = getSources(config).find(item => item.id === (request.sourceId || config.sourceId || 'official'))
  if (!source) throw new CcRuntimeError('invalid-source')
  try {
    const release = await lookupRelease(source, request.version ?? config.installVersion ?? RECOMMENDED_VERSION)
    const installed = (await getManagedCatalogEntries(release.version, release.platform)).find(entry =>
      !['unavailable', 'incompatible'].includes(entry.installation.compatibility)
      && entry.integrity?.checksum === release.checksum)
    return { ...release, ...(installed ? { installedPath: installed.installation.path } : {}) }
  } catch (error) {
    console.warn('[CcRuntime] Release lookup did not complete', { sourceId: source.id, issue: issueFromError(error, 'source-unreachable') })
    throw error
  }
}

export async function selectCcInstallation(path: string): Promise<CcInstallation> {
  const entry = await getCatalogEntry(path)
  let result: CcInstallation
  if (entry?.integrity && entry.installation.version) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new CcRuntimeError('probe-timeout')), 30_000)
    try {
      const reused = await reuseManagedInstallation(entry.installation.version, entry.integrity.platform, controller.signal, { path })
      if (!reused) throw new CcRuntimeError((await getCatalogEntry(path))?.installation.issue || 'not-executable')
      result = reused
    } finally { clearTimeout(timeout) }
  } else result = await checkInstallation(path)
  if (!['verified', 'compatible'].includes(result.compatibility)) {
    if (entry) await rememberInstallation({ ...entry.installation, ...result, managed: entry.installation.managed })
    throw new CcRuntimeError(result.issue || 'protocol-unsupported')
  }
  await persistSelection(result)
  return result
}

async function persistSelection(result: CcInstallation, stillCurrent?: () => boolean): Promise<boolean> {
  await rememberInstallation(result)
  if (stillCurrent && !stillCurrent()) {
    console.log('[CcRuntime] Selection persistence preserved a newer choice')
    return false
  }
  try { persistConfig({ selectedPath: result.path }) } catch (error) {
    console.error('[CcRuntime] Checked runtime could not be selected', { issue: issueFromError(error, 'storage-failed') })
    throw new CcRuntimeError('storage-failed', { cause: error })
  }
  selectionRevision++
  console.log('[CcRuntime] Runtime selected', { version: result.version, kind: result.kind, managed: result.managed })
  return true
}

export async function resolveCcRuntimeLaunch(options: { deadlineMs?: number; signal?: AbortSignal } = {}) {
  const path = readConfig().selectedPath
  if (!path) return null
  return withCheckDeadline(signal => launchForInstallation(path, { signal }), options, 'Selected runtime check')
}

async function withCheckDeadline<T>(
  work: (signal: AbortSignal) => Promise<T | null>,
  options: { deadlineMs?: number; signal?: AbortSignal },
  activity: string
): Promise<T | null> {
  const controller = new AbortController()
  const abort = () => controller.abort(new CcRuntimeError('cancelled'))
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const deadline = setTimeout(() => controller.abort(new CcRuntimeError('probe-timeout')), options.deadlineMs ?? 8000)
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      work(controller.signal).then(result => controller.signal.aborted ? null : result),
      new Promise<null>(resolve => {
        onAbort = () => {
          console.warn('[CcRuntime] Check stopped at its deadline or cancellation', { activity, issue: issueFromError(controller.signal.reason, 'cancelled') })
          resolve(null)
        }
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      })
    ])
  } finally {
    clearTimeout(deadline)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    options.signal?.removeEventListener('abort', abort)
  }
}

export async function discoverAndSelectCcRuntime(options: { deadlineMs?: number; signal?: AbortSignal } = {}): Promise<CcInstallation | null> {
  const initialConfig = getConfig()
  const initialPath = initialConfig.agent?.ccRuntime?.selectedPath
  const initialEngine = initialConfig.agent?.sdkEngine
  return withCheckDeadline(async signal => {
    const selected = initialPath
    const result = selected ? await checkInstallation(selected, { signal })
      : (await discoverInstallations(undefined, { signal, stopOnCompatible: true })).installations.find(item => ['verified', 'compatible'].includes(item.compatibility))
    if (signal.aborted || !result || !['verified', 'compatible'].includes(result.compatibility)) return null
    const current = getConfig().agent
    if (current?.ccRuntime?.selectedPath !== initialPath || current?.sdkEngine !== initialEngine) {
      console.log('[CcRuntime] Initial discovery retained a newer user choice')
      return null
    }
    if (!selected && !await persistSelection(result, () => {
      const latest = getConfig().agent
      return latest?.ccRuntime?.selectedPath === initialPath && latest?.sdkEngine === initialEngine
    })) return null
    return result
  }, options, 'Initial discovery')
}

export async function installCcRuntime(request: CcInstallRequest = {}): Promise<CcInstallation> {
  if (installController) throw new CcRuntimeError('install-busy')
  const config = readConfig()
  const source = getSources(config).find(item => item.id === (request.sourceId || config.sourceId || 'official'))
  if (!source) throw new CcRuntimeError('invalid-source')
  const version = request.version ?? config.installVersion ?? RECOMMENDED_VERSION
  if (!isInstallVersion(version)) throw new CcRuntimeError('invalid-version')
  const controller = new AbortController()
  const initialSelectionRevision = selectionRevision
  let finishInstall!: () => void
  installFinished = new Promise<void>(resolve => { finishInstall = resolve })
  installController = controller
  installProgress = { phase: 'manifest', downloadedBytes: 0 }
  console.log('[CcRuntime] Managed installation started', { sourceId: source.id, version })
  try {
    const result = await downloadAndPublish(source, version, controller.signal, value => { installProgress = value })
    if (controller.signal.aborted) throw new CcRuntimeError('cancelled')
    const checked = await checkInstallation(result.path, { signal: controller.signal })
    if (controller.signal.aborted) throw new CcRuntimeError('cancelled')
    if (!['verified', 'compatible'].includes(checked.compatibility)) throw new CcRuntimeError(checked.issue || 'protocol-unsupported')
    if (initialSelectionRevision === selectionRevision) await persistSelection(checked, () => initialSelectionRevision === selectionRevision)
    else console.log('[CcRuntime] Installed runtime retained without replacing a newer user selection', { version: checked.version })
    installProgress = { ...installProgress, phase: 'complete', version: checked.version }
    console.log('[CcRuntime] Managed installation completed', { version: checked.version })
    return checked
  } catch (error) {
    const issue = issueFromError(error, 'storage-failed')
    const stage = installProgress.phase
    installProgress = { ...installProgress, phase: issue === 'cancelled' ? 'cancelled' : 'error', issue }
    console.warn('[CcRuntime] Managed installation did not complete', { version, stage, issue })
    throw new CcRuntimeError(issue, { cause: error })
  } finally {
    installController = undefined
    finishInstall()
    installFinished = undefined
  }
}

export function cancelCcInstall(): boolean {
  if (!installController) return false
  installController.abort()
  console.log('[CcRuntime] Managed installation cancellation requested')
  return true
}

export async function shutdownCcRuntime(): Promise<void> {
  cancelCcInstall()
  clearReleaseCache()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled([shutdownProbes(), installFinished]),
      new Promise<void>(resolve => {
        timeout = setTimeout(() => {
          console.warn('[CcRuntime] Shutdown cleanup exceeded its deadline')
          resolve()
        }, 2000)
      })
    ])
  } finally { if (timeout) clearTimeout(timeout) }
}
