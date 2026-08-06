/**
 * Agent Module - Resolved SDK
 *
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║  SINGLE ENTRY POINT FOR ALL SDK IMPORTS                          ║
 * ║                                                                   ║
 * ║  Rule: No other file may import directly from                    ║
 * ║    @anthropic-ai/claude-agent-sdk, @hello-halo/agent-sdk, or      ║
 * ║    @openai/codex-sdk                                           ║
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
 * └─────────────────────────────────────────────────────────────────┘
 *
 * SDK engine values (config.agent.sdkEngine):
 *   'anthropic' (default) → @anthropic-ai/claude-agent-sdk (CC SDK)
 *   'halo'                → @hello-halo/agent-sdk (Halo SDK)
 *   'codex'               → @openai/codex-sdk through CC protocol adapter
 *
 * Engine selection degrades, it does not abort:
 *   The selected engine is user configuration; whether its package shipped is
 *   a property of the build. When they disagree, initSdk() falls back to an
 *   engine this build can run and records the degradation for the UI to
 *   surface. This replaces an earlier hard-constraint policy that threw on a
 *   missing package: initSdk() is awaited before the window exists, so the
 *   throw took down the whole bootstrap — no window, no IPC handlers, and no
 *   way for the user to correct the setting that caused it. A degraded engine
 *   is recoverable; an unusable app is not.
 *
 * Startup requirement:
 *   initSdk() must be called once during app bootstrap, before any
 *   SDK function is used. All exported functions throw if called
 *   before initialization.
 */

import type { z } from 'zod'
import { getConfig } from '../../foundation/config.service'
import { installSdkLogger } from '../../foundation/logging'
import { getEngineAvailability, type EngineAvailability } from './engine-availability'
import {
  ANTHROPIC_CAPABILITIES,
  HALO_CAPABILITIES,
  defaultCapabilitiesFor,
  type EngineCapabilities,
  type EngineId,
} from './capabilities'

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

// Engine the config asked for, when it differs from the one actually loaded.
// Null while they agree, which is the normal case.
let _degradedFrom: EngineId | null = null

/**
 * Order engines are tried in once the configured one is ruled out. Anthropic
 * leads because it is the default engine and the only one whose package is a
 * plain registry dependency.
 */
const FALLBACK_ORDER: EngineId[] = ['anthropic', 'halo', 'codex']

/** Human-readable engine label used in startup logs. */
const ENGINE_LABELS: Record<EngineId, string> = {
  anthropic: 'CC SDK (@anthropic-ai/claude-agent-sdk)',
  halo: 'Halo SDK (@hello-halo/agent-sdk)',
  codex: 'Codex SDK (@openai/codex-sdk adapter)',
}

// ============================================
// Initialization
// ============================================

/**
 * Initialize the SDK module.
 *
 * Must be called once at startup before any SDK functions are used.
 * Safe to call multiple times — subsequent calls return the same promise.
 *
 * Never rejects: this runs before the main window exists, so a rejection would
 * abort bootstrap and leave the app without IPC handlers. When no engine can be
 * loaded the SDK stays uninitialized and individual SDK calls fail instead.
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
  const requested = normalizeEngineId(getConfig().agent?.sdkEngine)
  console.log(`[SDK] Initializing engine: ${requested}`)

  const availability = await getEngineAvailability()
  const attemptOrder = buildAttemptOrder(requested, availability)

  if (attemptOrder.length === 0) {
    console.error(
      '[SDK] No agent engine is available in this build. Agent features are disabled ' +
      'until the app is reinstalled from a complete package.'
    )
    return
  }

  for (const engineId of attemptOrder) {
    const startTime = performance.now()
    try {
      _sdk = await loadEngine(engineId)
    } catch (error) {
      // The probe reported this engine as present, so a failure here means the
      // shipped package is unusable rather than absent. Try the next candidate.
      console.error(`[SDK] Engine "${engineId}" failed to load:`, (error as Error).message)
      continue
    }

    _engine = engineId
    _degradedFrom = engineId === requested ? null : requested

    const descriptor = availability.find(a => a.engineId === engineId)
    const duration = (performance.now() - startTime).toFixed(1)
    console.log(
      `[SDK] Active engine: ${ENGINE_LABELS[engineId]} ` +
      `version=${descriptor?.version || 'unknown'} ` +
      `fingerprint=${descriptor?.fingerprint || 'n/a'} [${duration}ms]`
    )
    if (_degradedFrom) {
      console.warn(
        `[SDK] Configured engine "${_degradedFrom}" is not available in this build; ` +
        `running on "${engineId}". The stored setting is left untouched.`
      )
    }
    return
  }

  console.error(
    `[SDK] Every available engine failed to load (tried: ${attemptOrder.join(', ')}). ` +
    'Agent features are disabled for this session.'
  )
}

/** Coerce an arbitrary persisted value to a known engine id. */
function normalizeEngineId(value: unknown): EngineId {
  if (value === 'anthropic' || value === 'halo' || value === 'codex') return value
  if (value != null && value !== '') {
    console.warn(`[SDK] Unknown SDK engine "${String(value)}" in config; using "anthropic".`)
  }
  return 'anthropic'
}

/**
 * Engines to try, most preferred first: the configured one when this build
 * carries it, then the remaining available engines in fallback order.
 */
function buildAttemptOrder(requested: EngineId, availability: EngineAvailability[]): EngineId[] {
  const available = new Set(availability.filter(a => a.available).map(a => a.engineId))
  const order: EngineId[] = []
  if (available.has(requested)) order.push(requested)
  for (const engineId of FALLBACK_ORDER) {
    if (engineId !== requested && available.has(engineId)) order.push(engineId)
  }
  return order
}

async function loadEngine(engineId: EngineId): Promise<SdkModule> {
  if (engineId === 'halo') {
    const sdk = await loadHaloSdk()
    // Inject Halo's electron-log-backed logger into the SDK.
    // SDK exposes setLogger() — if available, wire it up.
    if (typeof (sdk as any).setLogger === 'function') {
      installSdkLogger((sdk as any).setLogger)
    }
    return sdk
  }
  if (engineId === 'codex') return loadCodexSdk()
  return loadCcSdk()
}

// ============================================
// SDK Loaders
// ============================================
// Reached only for engines the availability probe reported as present, so a
// throw here means the shipped package is unusable rather than missing.
// doInitSdk() catches it and moves to the next candidate engine.

async function loadHaloSdk(): Promise<SdkModule> {
  // @vite-ignore: Exclude from bundler resolution — loaded only at runtime
  // when engine='halo'. If user deletes this package and uses CC SDK,
  // this code path is never executed.
  // @ts-ignore: Module path resolved at runtime, no static type declaration
  const sdk = await import(/* @vite-ignore */ '@hello-halo/agent-sdk')
  return sdk as unknown as SdkModule
}

async function loadCodexSdk(): Promise<SdkModule> {
  // Codex no longer depends on `@openai/codex-sdk`'s TypeScript surface at
  // runtime — Halo speaks directly to the `codex app-server` binary via
  // JSON-RPC. We still rely on `@openai/codex` (the CLI package) being
  // installed because it ships the platform-native binary; that resolution
  // happens inside `codex/transport/connection.ts` (`resolveBundledCodexBinary`).
  const { createCodexSdkModule } = await import('./codex')
  return createCodexSdkModule() as unknown as SdkModule
}

async function loadCcSdk(): Promise<SdkModule> {
  // @vite-ignore: Exclude from bundler resolution — loaded only at runtime
  // when engine='anthropic' (default). If user deletes this package and
  // uses Halo SDK, this code path is never executed.
  const sdk = await import(/* @vite-ignore */ '@anthropic-ai/claude-agent-sdk')
  return sdk as unknown as SdkModule
}

// ============================================
// Runtime Guard
// ============================================

function ensureInitialized(): SdkModule {
  if (!_sdk) {
    // initSdk() never rejects, so after it has run a null module means no
    // engine in this build could be loaded — not a bootstrap ordering bug.
    throw new Error(
      _initPromise
        ? '[SDK] No agent engine could be loaded in this build — agent features ' +
          'are disabled. See the "[SDK]" startup logs for each engine\'s failure.'
        : '[SDK] SDK not initialized. initSdk() must be called during app bootstrap ' +
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

/** Handler input inferred from the zod shape a tool declares. */
type ToolInput<Shape extends Record<string, z.ZodTypeAny>> = {
  [K in keyof Shape]: z.infer<Shape[K]>
}

/**
 * Define an MCP tool with schema validation.
 *
 * The runtime behavior is whatever the active SDK provides; this wrapper only
 * adds compile-time typing so handler `input` is inferred from the zod shape
 * instead of falling to implicit `any`.
 *
 * @example
 * const myTool = tool(
 *   'my_tool',
 *   'Does something useful',
 *   { path: z.string() },
 *   async (input) => { ... }  // input: { path: string }
 * )
 */
export function tool<Shape extends Record<string, z.ZodTypeAny>>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (input: ToolInput<Shape>, extra?: unknown) => Promise<any>
): any {
  if (process.env.SDK_DEBUG) {
    console.log(`[SDK] tool() called, engine=${_engine}`)
  }
  return ensureInitialized().tool(name, description, inputSchema, handler)
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
 * The engine the user configured, when it is not the one running. Null in the
 * normal case where the configured engine loaded.
 *
 * The stored setting is deliberately left untouched on degradation, so this is
 * the only signal that the running engine differs from the chosen one. The UI
 * uses it to explain the mismatch instead of silently showing a setting that
 * does not reflect reality.
 */
export function getDegradedFromEngine(): EngineId | null {
  return _degradedFrom
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
