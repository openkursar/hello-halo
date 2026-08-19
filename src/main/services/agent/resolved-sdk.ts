/**
 * Agent Module - Resolved SDK
 *
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║  SINGLE ENTRY POINT FOR ALL SDK IMPORTS                          ║
 * ║                                                                   ║
 * ║  Rule: No other file may import directly from                    ║
 * ║    @anthropic-ai/claude-agent-sdk, @hello-halo/agent-sdk,         ║
 * ║    @openai/codex-sdk, or a dsh runtime package                    ║
 * ║  All SDK access must go through this file.                       ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Architecture:
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  ZERO STATIC SDK IMPORTS                                        │
 * │                                                                  │
 * │  All SDK functions (tool, createSdkMcpServer, createSession,    │
 * │  query) are loaded dynamically at runtime via initSdk().        │
 * │  This enables true engine switching:                            │
 * │                                                                  │
 * │  • Delete CC SDK package     → system runs on Halo/Codex only   │
 * │  • Delete Halo SDK package   → system runs on CC/Codex only     │
 * │  • Delete Codex SDK package  → system runs on CC/Halo only      │
 * │                                                                  │
 * │  The three engines above are a hard constraint: if the          │
 * │  configured SDK is not available, startup fails immediately     │
 * │  with a clear error message.                                     │
 * │                                                                  │
 * │  'dsh' is the exception. Its runtime is an optional package     │
 * │  that most builds do not ship, so a missing runtime degrades    │
 * │  to the first available engine in FALLBACK_ORDER instead of     │
 * │  bricking startup for a user who only wanted to try it.         │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * SDK engine values (config.agent.sdkEngine):
 *   'anthropic' (default) → @anthropic-ai/claude-agent-sdk (CC SDK)
 *   'halo'                → @hello-halo/agent-sdk (Halo SDK)
 *   'codex'               → @openai/codex-sdk through CC protocol adapter
 *   'dsh'                 → @deepseek-ai/dsh runtime through CC protocol adapter
 *
 * Startup requirement:
 *   initSdk() must be called once during app bootstrap, before any
 *   SDK function is used. All exported functions throw if called
 *   before initialization.
 */

import { getConfig } from '../../foundation/config.service'
import { installSdkLogger } from '../../foundation/logging'
import {
  ANTHROPIC_CAPABILITIES,
  HALO_CAPABILITIES,
  defaultCapabilitiesFor,
  type EngineCapabilities,
  type EngineId,
} from './capabilities'
import { probeEngine } from './engine-availability'

// ============================================
// Engine Registry
// ============================================

/** Log/diagnostic label per engine. User-facing names come from capabilities. */
export const ENGINE_LABELS: Record<EngineId, string> = {
  anthropic: 'CC SDK (@anthropic-ai/claude-agent-sdk)',
  halo: 'Halo SDK (@hello-halo/agent-sdk)',
  codex: 'Codex SDK (@openai/codex-sdk adapter)',
  dsh: 'DeepSeek Harness (@deepseek-ai/dsh runtime adapter)',
}

/**
 * Order in which a degraded boot picks a replacement engine. `dsh` is absent
 * on purpose: it is opt-in only and must never be selected on the user's
 * behalf.
 */
export const FALLBACK_ORDER: EngineId[] = ['anthropic', 'halo', 'codex']

// ============================================
// SDK Module Interface
// ============================================

/**
 * Minimal shape of what we need from either SDK.
 * Both SDKs/adapters must provide these exports with compatible runtime behavior.
 *
 * `capabilities` is optional because the upstream CC / Halo SDK packages do
 * not export it; we attach a default constant from `./capabilities.ts` after
 * loading.
 */
interface SdkModule {
  tool: (...args: any[]) => any
  createSdkMcpServer: (options: any) => any
  createSession?: (options: any) => Promise<any>
  unstable_v2_createSession?: (options: any) => Promise<any>
  query: (params: any) => AsyncIterable<any>
  capabilities?: EngineCapabilities
}

// ============================================
// Module State
// ============================================

// Cached SDK module — set once by initSdk(), never changes after that.
// A process restart is required to switch engines.
let _sdk: SdkModule | null = null
let _engine: string | null = null
let _initPromise: Promise<void> | null = null

// ============================================
// Initialization
// ============================================

/**
 * Initialize the SDK module.
 *
 * Must be called once at startup before any SDK functions are used.
 * Safe to call multiple times — subsequent calls return the same promise.
 *
 * @throws Error if the configured SDK is not available (hard constraint, no fallback)
 */
export async function initSdk(): Promise<void> {
  // Idempotent: return existing promise if already initializing/initialized
  if (_initPromise) {
    return _initPromise
  }

  _initPromise = doInitSdk()
  return _initPromise
}

async function doInitSdk(): Promise<void> {
  let engine: EngineId = (getConfig().agent?.sdkEngine ?? 'anthropic') as EngineId
  console.log(`[SDK] Initializing engine: ${engine}`)

  const startTime = performance.now()

  if (engine === 'dsh') {
    const dshSdk = await loadDshSdk()
    if (dshSdk) {
      _sdk = dshSdk
      _engine = 'dsh'
      logActiveEngine('dsh', startTime)
      return
    }
    engine = firstAvailableEngine()
    console.warn(`[SDK] Degrading to ${ENGINE_LABELS[engine]} for this run. Engine setting is unchanged.`)
  }

  if (engine === 'halo') {
    _sdk = await loadHaloSdk()
    _engine = 'halo'
    // Inject Halo's electron-log-backed logger into the SDK.
    // SDK exposes setLogger() — if available, wire it up.
    if (typeof (_sdk as any).setLogger === 'function') {
      installSdkLogger((_sdk as any).setLogger)
    }
    logActiveEngine('halo', startTime)
    return
  }

  if (engine === 'codex') {
    _sdk = await loadCodexSdk()
    _engine = 'codex'
    logActiveEngine('codex', startTime)
    return
  }

  if (engine !== 'anthropic') {
    throw new Error(
      `[SDK] Unknown SDK engine "${engine}". Expected "anthropic", "halo", "codex", or "dsh".`
    )
  }

  _sdk = await loadCcSdk()
  _engine = 'anthropic'
  logActiveEngine('anthropic', startTime)
}

function logActiveEngine(engine: EngineId, startTime: number): void {
  const duration = (performance.now() - startTime).toFixed(1)
  console.log(`[SDK] Active engine: ${ENGINE_LABELS[engine]} [${duration}ms]`)
}

/**
 * First engine in FALLBACK_ORDER whose package is present. Falls back to the
 * default engine when nothing probes positive, so bootstrap always has a
 * loader to run — the loader itself still reports a missing package.
 */
function firstAvailableEngine(): EngineId {
  return FALLBACK_ORDER.find((id) => probeEngine(id).available) ?? 'anthropic'
}

// ============================================
// SDK Loaders (Hard Constraint, No Fallback)
// ============================================

async function loadHaloSdk(): Promise<SdkModule> {
  try {
    // @vite-ignore: Exclude from bundler resolution — loaded only at runtime
    // when engine='halo'. If user deletes this package and uses CC SDK,
    // this code path is never executed.
    // @ts-ignore: Module path resolved at runtime, no static type declaration
    const sdk = await import(/* @vite-ignore */ '@hello-halo/agent-sdk')
    return sdk as unknown as SdkModule
  } catch (error) {
    const message =
      '[SDK] Failed to load @hello-halo/agent-sdk.\n' +
      'The configured engine is "halo" but the package is not available.\n' +
      'Solutions:\n' +
      '  1. Install @hello-halo/agent-sdk, OR\n' +
      '  2. Change config.agent.sdkEngine to "anthropic" or "codex" and restart'
    console.error(message)
    throw new Error(message)
  }
}

async function loadCodexSdk(): Promise<SdkModule> {
  // Codex no longer depends on `@openai/codex-sdk`'s TypeScript surface at
  // runtime — Halo speaks directly to the `codex app-server` binary via
  // JSON-RPC. We still rely on `@openai/codex` (the CLI package) being
  // installed because it ships the platform-native binary; that resolution
  // happens inside `codex/transport/connection.ts` (`resolveBundledCodexBinary`).
  try {
    const { createCodexSdkModule } = await import('./codex')
    return createCodexSdkModule() as unknown as SdkModule
  } catch (error) {
    const message =
      '[SDK] Failed to load Codex adapter.\n' +
      'The configured engine is "codex" but the adapter could not be loaded.\n' +
      'Solutions:\n' +
      '  1. Ensure @openai/codex (CLI binary package) is installed, OR\n' +
      '  2. Change config.agent.sdkEngine to "anthropic" or "halo" and restart'
    console.error(message, error)
    throw new Error(message)
  }
}

/**
 * Load the dsh adapter, or return null if this build cannot run it.
 *
 * Unlike its siblings this loader never throws: the dsh runtime is optional,
 * and a user who selected the engine on a build that does not ship it must
 * still get a working app rather than a failed bootstrap. The caller degrades
 * to `FALLBACK_ORDER`.
 */
async function loadDshSdk(): Promise<SdkModule | null> {
  const availability = probeEngine('dsh')
  if (!availability.available) {
    console.warn(
      `[SDK] DeepSeek Harness runtime unavailable: ${availability.reason ?? 'unknown reason'}.`
    )
    return null
  }

  try {
    const { createDshSdkModule } = await import('./dsh')
    return createDshSdkModule() as unknown as SdkModule
  } catch (error) {
    console.error('[SDK] Failed to load the DeepSeek Harness adapter.', error)
    return null
  }
}

async function loadCcSdk(): Promise<SdkModule> {
  try {
    // @vite-ignore: Exclude from bundler resolution — loaded only at runtime
    // when engine='anthropic' (default). If user deletes this package and
    // uses Halo SDK, this code path is never executed.
    const sdk = await import(/* @vite-ignore */ '@anthropic-ai/claude-agent-sdk')
    return sdk as unknown as SdkModule
  } catch (error) {
    const message =
      '[SDK] Failed to load @anthropic-ai/claude-agent-sdk.\n' +
      'The configured engine is "anthropic" but the package is not available.\n' +
      'Solutions:\n' +
      '  1. Install @anthropic-ai/claude-agent-sdk, OR\n' +
      '  2. Change config.agent.sdkEngine to "halo" or "codex" and restart'
    console.error(message)
    throw new Error(message)
  }
}

// ============================================
// Runtime Guard
// ============================================

function ensureInitialized(): SdkModule {
  if (!_sdk) {
    throw new Error(
      '[SDK] SDK not initialized. initSdk() must be called during app bootstrap ' +
      'before any SDK function is used.'
    )
  }
  return _sdk
}

// ============================================
// Exported SDK Functions
// ============================================
// All functions delegate to the dynamically loaded SDK module.
// Consumer code does not need to change — same function signatures.

/**
 * Define an MCP tool with schema validation.
 *
 * @example
 * const myTool = tool(
 *   'my_tool',
 *   'Does something useful',
 *   z.object({ path: z.string() }),
 *   async (args) => { ... }
 * )
 */
export function tool(...args: any[]): any {
  if (process.env.SDK_DEBUG) {
    console.log(`[SDK] tool() called, engine=${_engine}`)
  }
  return ensureInitialized().tool(...args)
}

/**
 * Create an in-process MCP server from tool definitions.
 *
 * @example
 * const server = createSdkMcpServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   tools: [tool1, tool2]
 * })
 */
export function createSdkMcpServer(options: any): any {
  return ensureInitialized().createSdkMcpServer(options)
}

/**
 * Create an agent SDK session.
 *
 * Unified replacement for:
 *   - CC SDK:   unstable_v2_createSession(options)
 *   - Halo SDK: createSession(options)
 */
export async function createSession(options: Record<string, any>): Promise<any> {
  const sdk = ensureInitialized()

  // Halo SDK exposes createSession; CC SDK exposes unstable_v2_createSession.
  // Normalise to a single call site here so callers never see the difference.
  const fn = sdk.createSession ?? sdk.unstable_v2_createSession
  if (!fn) {
    throw new Error(
      '[SDK] createSession not found in active SDK. ' +
        'Expected createSession (Halo) or unstable_v2_createSession (CC).'
    )
  }

  const fnName = sdk.createSession ? 'createSession' : 'unstable_v2_createSession'
  console.log(`[SDK] createSession via ${fnName} (engine=${_engine})`)
  return fn(options)
}

/**
 * Run a one-shot agent query (used for MCP connection testing).
 *
 * Returns an AsyncIterable of SDK messages.
 */
export function query(params: any): AsyncIterable<any> {
  return queryIterable(params)
}

async function* queryIterable(params: any): AsyncGenerator<any> {
  const sdk = ensureInitialized()

  if (!sdk.query) {
    throw new Error('[SDK] query not found in active SDK.')
  }

  yield* sdk.query(params)
}

// ============================================
// Diagnostic Utilities
// ============================================

/**
 * Get the current SDK engine name.
 * Returns null if SDK is not initialized.
 */
export function getActiveEngine(): EngineId | null {
  return _engine as EngineId | null
}

/**
 * Capability descriptor for the active engine.
 *
 * Returns `null` if the SDK has not been initialized (caller should treat
 * as "loading" and re-fetch when a session is created). Falls back to the
 * declarative default in `./capabilities.ts` if the engine module did not
 * export its own capabilities object — this keeps every engine accessible
 * to the renderer regardless of SDK package update timing.
 */
export function getEngineCapabilities(): EngineCapabilities | null {
  if (!_sdk || !_engine) return null
  if (_sdk.capabilities) return _sdk.capabilities
  // Anthropic / Halo SDK packages don't export capabilities yet; supply the
  // declarative default. Codex always has its own.
  if (_engine === 'anthropic') return ANTHROPIC_CAPABILITIES
  if (_engine === 'halo') return HALO_CAPABILITIES
  return defaultCapabilitiesFor(_engine as EngineId)
}

/**
 * Check if SDK is initialized.
 * Useful for conditional logic without throwing.
 */
export function isInitialized(): boolean {
  return _sdk !== null
}

/**
 * Get diagnostic info about the current SDK state.
 * Useful for debugging and verification.
 */
export function getSdkDiagnostics(): { engine: string | null; initialized: boolean; functions: string[] } {
  return {
    engine: _engine,
    initialized: _sdk !== null,
    functions: _sdk ? Object.keys(_sdk).filter(k => typeof (_sdk as any)[k] === 'function') : []
  }
}
