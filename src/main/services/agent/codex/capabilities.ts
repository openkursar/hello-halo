/**
 * Codex app-server capability descriptor.
 *
 * Reflects the actual V2 protocol surface Halo consumes via JSON-RPC over
 * stdio. Differences from CC that the renderer must adapt to:
 *
 *   - tool input arrives as a single payload (no `input_json_delta` stream).
 *   - todos are 2-state (pending/completed), no `activeForm`.
 *   - sub-agents are imperative (Codex orchestrates internally; Halo only
 *     sees a flat tool stream), so the SubAgentTimeline UI collapses.
 *   - `Edit`/`Write` tool calls are synthesized from the engine's
 *     `file_change` item, with patch fidelity. Marked lossy because
 *     line-level oldString/newString reconstruction is not always
 *     available — the diff renderer falls back to a unified patch view.
 *
 * Anything the engine genuinely supports natively (stream text/reasoning
 * tokens, real-time shell stdout, MCP, session resume via `thread/resume`,
 * multimodal images, interrupt, AskUserQuestion via elicitation bridge,
 * thread compaction) is advertised as supported here.
 */

import type { EngineCapabilities } from '../capabilities'

export const CODEX_CAPABILITIES: EngineCapabilities = {
  engineId: 'codex',
  // Two-token brand string aligns visually with sibling engines on the
  // empty-state "Powered by ..." line ("Claude Code" / "Halo SDK" /
  // "Codex Agent"). The short EngineBadge label still uses just "Codex".
  displayName: 'Codex Agent',
  streaming: {
    text: 'token',
    reasoning: 'token',
    toolInput: 'final-only',
    // Codex emits commandExecution output deltas but Halo currently buffers
    // them and forwards as a single tool_result on item.completed (matching
    // CC's behavior). Advertise 'item' to be honest with the renderer; flip
    // to 'token' when the renderer adds a streaming output channel.
    toolOutput: 'item',
  },
  tools: {
    native: ['Bash', 'WebSearch', 'Mcp'],
    synthetic: [
      { kind: 'Edit', from: 'file_change', lossy: true },
      { kind: 'Write', from: 'file_change', lossy: true },
      { kind: 'TodoWrite', from: 'plan', lossy: true },
    ],
    shellHeuristics: false,
  },
  todo: { states: ['pending', 'completed'], hasActiveForm: false },
  subAgent: { model: 'imperative', visibleLifecycle: false },
  features: {
    skills: true,
    mcp: true,
    hooks: false,
    sessionResume: true,
    interrupt: true,
    multimodalImage: true,
    contextCompaction: true,
    askUserQuestion: true,
  },
}
