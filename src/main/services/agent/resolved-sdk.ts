/** Engine factories are shared; every session and query borrows one captured engine. */
import { getConfig } from '../../foundation/config.service'
import { installSdkLogger } from '../../foundation/logging'
import { ENGINE_IDS, isEngineId, type EngineId } from '../../../shared/types/engine'
import { getSdkInitialization, initializeSdkOnce, waitForSdkInitialization } from './initialization'
import { migrateCcRuntimeSelection } from './engine-migration'
import { getEngineAvailability } from './engine-availability'
import { defaultCapabilitiesFor, type EngineCapabilities } from './capabilities'
import { tool as defineTool, createSdkMcpServer as defineMcpServer } from './mcp/sdk-server'

interface SdkModule {
  createSession?: (options: any) => Promise<any>
  unstable_v2_createSession?: (options: any) => Promise<any>
  query: (params: any) => AsyncIterable<any>
  capabilities?: EngineCapabilities
  initialize?: () => Promise<void>
  close?: () => Promise<void>
  diagnostics?: () => unknown
  setLogger?: (...args: any[]) => void
}

interface EngineEntry {
  id: EngineId
  module?: SdkModule
  loading?: Promise<SdkModule>
  initializing?: Promise<void>
  closing?: Promise<void>
  borrowers: Set<AbortController>
}

const entries = new Map<EngineId, EngineEntry>(ENGINE_IDS.map(id => [id, { id, borrowers: new Set() }]))
const FALLBACK_ORDER: EngineId[] = ['halo', 'anthropic', 'codex']
let defaultEngine: EngineId | null = null
let startupEngine: EngineId | null = null
let degradedFrom: EngineId | null = null
let resolvedDefaultKey: string | undefined
let defaultResolution: Promise<EngineId> | undefined
let shuttingDown = false

export class EngineUnavailableError extends Error {
  readonly code = 'ENGINE_UNAVAILABLE'
  constructor(readonly engineId: EngineId, reason: string, options?: ErrorOptions) {
    super(`Engine "${engineId}" is unavailable: ${reason}`, options)
    this.name = 'EngineUnavailableError'
  }
}

function preference(): { engineId: EngineId; key: string } {
  const agent = getConfig().agent
  const engineId = isEngineId(agent?.sdkEngine) ? agent.sdkEngine : 'halo'
  return { engineId, key: JSON.stringify([engineId, agent?.ccRuntime?.selectedPath ?? '']) }
}

function entryFor(engineId: EngineId): EngineEntry {
  if (!isEngineId(engineId)) throw new TypeError('Unknown agent engine')
  return entries.get(engineId)!
}

async function loadEngine(engineId: EngineId): Promise<SdkModule> {
  if (engineId === 'halo') {
    // @ts-ignore: The separately packaged SDK is resolved at runtime.
    const sdk = await import(/* @vite-ignore */ '@hello-halo/agent-sdk/worker')
    const { createHaloSdkModule } = await import('./halo')
    const module = createHaloSdkModule(sdk) as unknown as SdkModule
    if (module.setLogger) installSdkLogger(module.setLogger)
    return module
  }
  if (engineId === 'codex') return (await import('./codex')).createCodexSdkModule() as unknown as SdkModule
  if (engineId === 'dsh') return (await import('./dsh')).createDshSdkModule() as unknown as SdkModule
  return (await import('./cc')).createCcSdkModule() as SdkModule
}

async function ensureModule(engineId: EngineId): Promise<SdkModule> {
  const entry = entryFor(engineId)
  if (shuttingDown) throw new EngineUnavailableError(engineId, 'The application is shutting down')
  if (entry.closing) await entry.closing
  const descriptor = (await getEngineAvailability([engineId])).find(item => item.engineId === engineId)
  if (!descriptor?.available) throw new EngineUnavailableError(engineId, descriptor?.reason || 'The runtime is not installed')
  if (entry.closing) await entry.closing
  if (shuttingDown) throw new EngineUnavailableError(engineId, 'The application is shutting down')
  if (entry.module) return entry.module
  if (!entry.loading) {
    const loading = loadEngine(engineId).then(module => {
      entry.module = module
      return module
    }).catch(cause => {
      console.error('[SDK] Engine module could not be loaded', { engineId, cause })
      throw new EngineUnavailableError(engineId, 'The runtime could not be loaded', { cause })
    }).finally(() => { if (entry.loading === loading) entry.loading = undefined })
    entry.loading = loading
  }
  return entry.loading
}

/** Explicit choices are never substituted with another engine. This does not start workers. */
export async function ensureEngineAvailable(engineId: EngineId): Promise<void> { await ensureModule(engineId) }

async function initializeEntry(entry: EngineEntry, module: SdkModule): Promise<void> {
  if (!entry.initializing) {
    const initializing = Promise.resolve().then(() => module.initialize?.()).catch(error => {
      if (entry.initializing === initializing) entry.initializing = undefined
      console.error('[SDK] Engine runtime initialization failed', { engineId: entry.id, error })
      throw error
    })
    entry.initializing = initializing
  }
  await entry.initializing
}

async function closeEntry(entry: EngineEntry, force = false): Promise<void> {
  if (entry.closing) {
    await entry.closing
    if (force) await closeEntry(entry, true)
    return
  }
  if (!force && (entry.borrowers.size || entry.id === defaultEngine)) return
  const closing = Promise.resolve().then(async () => {
    if (entry.loading) await entry.loading.catch(() => undefined)
    if (entry.initializing) await entry.initializing.catch(() => undefined)
    if (!force && (entry.borrowers.size || entry.id === defaultEngine)) return
    const module = entry.module
    if (!module?.close) return
    entry.module = undefined
    entry.initializing = undefined
    await module.close()
    console.log('[SDK] Shared engine runtime closed', { engineId: entry.id })
  }).catch(error => {
    console.error('[SDK] Shared engine runtime cleanup failed', { engineId: entry.id, error })
  }).finally(() => { if (entry.closing === closing) entry.closing = undefined })
  entry.closing = closing
  return closing
}

async function resolveCurrentDefault(): Promise<EngineId> {
  while (true) {
    const wanted = preference()
    if (defaultResolution) {
      await defaultResolution
      if (resolvedDefaultKey === preference().key && defaultEngine) return defaultEngine
      continue
    }
    if (defaultEngine && resolvedDefaultKey === wanted.key && wanted.engineId !== 'anthropic') return defaultEngine
    const resolution = (async () => {
      for (const engineId of [...new Set([wanted.engineId, ...FALLBACK_ORDER])]) {
        try { await ensureModule(engineId) } catch (error) {
          if (!(error instanceof EngineUnavailableError)) throw error
          continue
        }
        if (preference().key !== wanted.key) return engineId
        const previous = defaultEngine
        defaultEngine = engineId
        resolvedDefaultKey = wanted.key
        degradedFrom = engineId === wanted.engineId ? null : wanted.engineId
        if (previous !== engineId) console.log('[SDK] Default engine resolved', { requested: wanted.engineId, engineId })
        if (previous && previous !== engineId) void closeEntry(entryFor(previous))
        return engineId
      }
      throw new EngineUnavailableError(wanted.engineId, 'No available fallback engine could be loaded')
    })()
    defaultResolution = resolution
    try {
      const resolved = await resolution
      if (preference().key === wanted.key) return resolved
    } finally { if (defaultResolution === resolution) defaultResolution = undefined }
  }
}

export function initSdk(): Promise<void> {
  return initializeSdkOnce(async () => {
    await migrateCcRuntimeSelection()
    try { startupEngine = await resolveCurrentDefault() }
    catch (error) { console.error('[SDK] No agent engine could be initialized:', error) }
  })
}

/** Capture this before asynchronous options/credential preparation for an unpinned session. */
export async function resolveDefaultEngine(): Promise<EngineId> {
  await waitForSdkInitialization()
  if (!getSdkInitialization()) throw new Error('[SDK] SDK not initialized. initSdk() must run during bootstrap.')
  return resolveCurrentDefault()
}

/** Synchronous compatibility view; execution paths use resolveDefaultEngine before binding. */
export function getDefaultEngine(): EngineId { return defaultEngine ?? 'halo' }
export function getStartupEngine(): EngineId { return startupEngine ?? getDefaultEngine() }
export function getActiveEngine(): EngineId | null { return defaultEngine }
export function getDegradedFromEngine(): EngineId | null { return degradedFrom }

export function getEngineCapabilities(engineId?: EngineId): EngineCapabilities | null {
  const id = engineId ?? defaultEngine
  return id ? entryFor(id).module?.capabilities ?? defaultCapabilitiesFor(id) : null
}

export const tool = defineTool
export const createSdkMcpServer = defineMcpServer

interface EngineBorrow {
  module: SdkModule
  controller: AbortController
  release: () => void
}

async function borrowEngine(engineId: EngineId, parent?: AbortSignal): Promise<EngineBorrow> {
  const entry = entryFor(engineId)
  if (shuttingDown) throw new EngineUnavailableError(engineId, 'The application is shutting down')
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  entry.borrowers.add(controller)
  let released = false
  const release = () => {
    if (released) return
    released = true
    parent?.removeEventListener('abort', abort)
    entry.borrowers.delete(controller)
    if (entry.id !== defaultEngine && !entry.borrowers.size) void closeEntry(entry)
  }
  try {
    const module = await ensureModule(engineId)
    if (shuttingDown || controller.signal.aborted) throw controller.signal.reason || new Error('Session creation was cancelled')
    await initializeEntry(entry, module)
    if (controller.signal.aborted) throw controller.signal.reason || new Error('Session creation was cancelled')
    return { module, controller, release }
  } catch (error) { release(); throw error }
}

function ownSession(session: any, engineId: EngineId, borrow: EngineBorrow): any {
  let closing: Promise<void> | undefined
  const close = (...args: unknown[]) => {
    if (closing) return
    let result
    try { result = session.close?.(...args) } catch (error) { borrow.release(); throw error }
    closing = Promise.resolve(result).then(() => session.flush?.()).catch(error => {
      console.warn('[SDK] Engine session cleanup failed', { engineId, error })
    }).finally(borrow.release)
    return result
  }
  const flush = async () => { if (closing) await closing; else await session.flush?.() }
  const methods = new Map<PropertyKey, unknown>()
  return new Proxy(session, {
    get(target, property) {
      if (property === 'engineId') return engineId
      if (property === 'close' || property === Symbol.dispose) return close
      if (property === 'flush') return flush
      if (property === Symbol.asyncDispose) return async () => { close(); await flush() }
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (!methods.has(property)) methods.set(property, value.bind(target))
      return methods.get(property)
    },
  })
}

export async function createSession(options: Record<string, any>): Promise<any> {
  await waitForSdkInitialization()
  const engineId = options.engineId ?? await resolveDefaultEngine()
  const borrow = await borrowEngine(engineId, options.abortController?.signal)
  const { engineId: _engineId, engineHandoffContent: _engineHandoffContent, engineHandoffRecovered: _engineHandoffRecovered, ...sessionOptions } = options
  try {
    const create = borrow.module.createSession ?? borrow.module.unstable_v2_createSession
    if (!create) throw new EngineUnavailableError(engineId, 'The adapter does not expose session creation')
    const session = await create({ ...sessionOptions, abortController: borrow.controller })
    return ownSession(session, engineId, borrow)
  } catch (error) { borrow.release(); throw error }
}

export function query(params: any): AsyncIterable<any> { return queryIterable(params) }

async function* queryIterable(params: any): AsyncGenerator<any> {
  await waitForSdkInitialization()
  const engineId = params.options?.engineId ?? await resolveDefaultEngine()
  const borrow = await borrowEngine(engineId, params.options?.abortController?.signal)
  const { engineId: _engineId, engineHandoffContent: _engineHandoffContent, engineHandoffRecovered: _engineHandoffRecovered, ...options } = params.options ?? {}
  try { yield* borrow.module.query({ ...params, options: { ...options, abortController: borrow.controller } }) }
  finally { borrow.release() }
}

/** Startup prewarms only the default; other runtimes start when a session borrows them. */
export async function initializeSdkRuntime(engineId: EngineId = getDefaultEngine()): Promise<void> {
  const entry = entryFor(engineId)
  await initializeEntry(entry, await ensureModule(engineId))
}

/** A targeted close never interrupts a borrower; a no-argument close is application shutdown. */
export async function closeSdkRuntime(engineId?: EngineId): Promise<void> {
  if (engineId) { await closeEntry(entryFor(engineId)); return }
  shuttingDown = true
  for (const entry of entries.values()) for (const controller of entry.borrowers) controller.abort()
  await Promise.all([...entries.values()].map(entry => closeEntry(entry, true)))
}

export function isInitialized(): boolean { return defaultEngine !== null }

export function getSdkDiagnostics() {
  const module = defaultEngine ? entryFor(defaultEngine).module : undefined
  return {
    engine: defaultEngine, initialized: defaultEngine !== null,
    functions: module ? Object.keys(module).filter(key => typeof (module as any)[key] === 'function') : [],
    runtime: module?.diagnostics?.(),
    engines: [...entries.values()].filter(entry => entry.module || entry.loading || entry.closing || entry.borrowers.size).map(entry => ({
      engineId: entry.id, borrowers: entry.borrowers.size, loading: Boolean(entry.loading), closing: Boolean(entry.closing), runtime: entry.module?.diagnostics?.()
    }))
  }
}
