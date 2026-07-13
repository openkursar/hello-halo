/**
 * Engine Capabilities — declarative description of what each agent SDK engine
 * can natively do.
 *
 * The renderer reads these flags via `agent:get-engine-capabilities` and uses
 * them to drive UI affordances (e.g. show "thinking..." placeholder when
 * reasoning is final-only, collapse subagent details when subagent model is
 * imperative). This keeps UI components engine-agnostic — they branch on
 * capability flags, never on engineId.
 *
 * The capability descriptor is THE single source of truth for engine
 * differences observable by the user. New differences MUST be encoded here
 * rather than by sniffing tool names or peeking at the engine string.
 *
 * IMPORTANT: this type is shared across the main/preload/renderer boundary
 * via IPC. Keep it serializable (no functions, no class instances). Adding
 * new fields is safe — renderer fallbacks tolerate missing flags.
 */

export type EngineId = 'anthropic' | 'halo' | 'codex'

/**
 * Logical tool kinds Halo's UI knows how to render. The renderer maps tool
 * calls to one of these via either:
 *   1. CC-shaped native name (Bash, Read, Edit, ...)
 *   2. Synthetic mapping declared in `EngineCapabilities.tools.synthetic`
 *
 * "Unknown" is the catch-all that renders a generic tool card.
 */
export type ToolKind =
  | 'Bash'
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Grep'
  | 'Glob'
  | 'WebSearch'
  | 'WebFetch'
  | 'TodoWrite'
  | 'Task'
  | 'Skill'
  | 'AskUserQuestion'
  | 'NotebookEdit'
  | 'Mcp'
  | 'Unknown'

/**
 * Todo state machine the engine emits. Anthropic CC has 3 states with an
 * activeForm field. Codex's plan is a 2-state binary (pending/completed),
 * so the UI must collapse the in_progress state when capabilities advertise
 * a 2-state model.
 */
export type TodoState = 'pending' | 'in_progress' | 'completed'

/** Streaming granularity for a content channel. */
export type StreamGranularity = 'token' | 'item' | 'final-only' | 'turn' | 'none'

export interface EngineCapabilities {
  engineId: EngineId
  /** Display label for engine badge (i18n is applied at render site). */
  displayName: string
  streaming: {
    /** Assistant text channel granularity. */
    text: 'token' | 'item' | 'turn'
    /** Reasoning / thinking channel granularity. */
    reasoning: 'token' | 'item' | 'final-only' | 'none'
    /** Tool input streaming (input_json_delta in CC). */
    toolInput: 'token' | 'final-only'
    /** Tool output (e.g. shell stdout) streaming. */
    toolOutput: 'token' | 'final-only'
  }
  tools: {
    /** Tool kinds the engine emits with its native CC-compatible name. */
    native: ToolKind[]
    /**
     * Synthetic mappings: engine emits `from` (its own item type) which the
     * adapter rewrites into a CC-shaped tool_use named for `kind`. `lossy`
     * indicates the rewritten input/output may not have full fidelity with
     * the CC original (UI may show a lighter/weaker rendering).
     */
    synthetic: { kind: ToolKind; from: string; lossy: boolean }[]
    /**
     * If true, the engine relies on heuristic shell-command parsing (e.g. a
     * Bash command containing `cat foo.txt` is treated as a Read). Codex
     * does not support this; CC does.
     */
    shellHeuristics: boolean
  }
  todo: {
    /** Todo states this engine emits. */
    states: TodoState[]
    /** Whether todos carry an `activeForm` (present continuous label) field. */
    hasActiveForm: boolean
  }
  subAgent: {
    /**
     * - `declarative`: engine surfaces structured Task/Agent lifecycle (CC).
     * - `imperative`: engine drives sub-tasks via its own runtime; Halo only
     *   sees a flat tool stream. UI collapses to a compact card.
     * - `none`: no subagents.
     */
    model: 'declarative' | 'imperative' | 'none'
    /** Whether sub-agent task lifecycle events are observable from outside. */
    visibleLifecycle: boolean
  }
  features: {
    skills: boolean
    mcp: boolean
    hooks: boolean
    sessionResume: boolean
    interrupt: boolean
    multimodalImage: boolean
    contextCompaction: boolean
    askUserQuestion: boolean
  }
}

// ============================================================================
// Built-in capability constants
// ============================================================================

/**
 * Anthropic Claude Code SDK — defines the canonical/maximal capability profile.
 * This is the reference target every other engine adapter aims to match.
 */
export const ANTHROPIC_CAPABILITIES: EngineCapabilities = {
  engineId: 'anthropic',
  displayName: 'Claude Code',
  streaming: {
    text: 'token',
    reasoning: 'token',
    toolInput: 'token',
    toolOutput: 'item',
  },
  tools: {
    native: [
      'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob',
      'WebSearch', 'WebFetch', 'TodoWrite', 'Task',
      'Skill', 'AskUserQuestion', 'NotebookEdit', 'Mcp',
    ],
    synthetic: [],
    shellHeuristics: true,
  },
  todo: { states: ['pending', 'in_progress', 'completed'], hasActiveForm: true },
  subAgent: { model: 'declarative', visibleLifecycle: true },
  features: {
    skills: true,
    mcp: true,
    hooks: true,
    sessionResume: true,
    interrupt: true,
    multimodalImage: true,
    contextCompaction: true,
    askUserQuestion: true,
  },
}

/**
 * Halo SDK — currently mirrors CC's capability set since it implements the
 * same protocol surface. Kept as a separate constant so future divergence is
 * a simple constant edit, not an architectural change.
 */
export const HALO_CAPABILITIES: EngineCapabilities = {
  ...ANTHROPIC_CAPABILITIES,
  engineId: 'halo',
  displayName: 'Halo SDK',
}

/**
 * Codex (app-server) — see codex/capabilities.ts for the canonical definition.
 * Re-exported here so callers don't need to touch the codex/ subtree to get
 * the descriptor.
 */
export { CODEX_CAPABILITIES } from './codex/capabilities'

import { CODEX_CAPABILITIES } from './codex/capabilities'

/**
 * Resolve capabilities for an engine id. Used by `getEngineCapabilities()`
 * in resolved-sdk.ts when the engine adapter does not export its own.
 */
export function defaultCapabilitiesFor(engineId: EngineId): EngineCapabilities {
  switch (engineId) {
    case 'anthropic': return ANTHROPIC_CAPABILITIES
    case 'halo': return HALO_CAPABILITIES
    case 'codex': return CODEX_CAPABILITIES
  }
}
