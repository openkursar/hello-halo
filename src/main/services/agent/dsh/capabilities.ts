/**
 * DeepSeek Harness (dsh) capability descriptor.
 *
 * Describes what Halo can actually observe through the runtime's stdio
 * JSON-RPC surface (`initialize` / `session/prompt` / `shutdown` plus the
 * `session.event`, `session.status`, `subagent.*` notifications). The wire
 * carries whole session-log envelopes, so the streaming vocabulary is rich,
 * but the request surface is narrow: there is no cancel method and the
 * runtime never sends a request back to Halo.
 *
 * Consequences encoded below:
 *   - every tool arrives under the runtime's own snake_case name, so every
 *     mapping is synthetic; there is no CC-shaped native tool.
 *   - no server→client request channel means no approval callback and no
 *     elicitation.
 *   - abandoning a turn means killing the runtime, which also ends the
 *     session; that is a process restart, not an interrupt.
 *
 * Anything the model can do is a plugin `runtime/cordis-config.ts` composes,
 * so a flag here is a claim about that composition and must be read against
 * it. Flags for plugins Halo does not compose stay false: over-claiming shows
 * the user affordances that silently do nothing.
 */

import type { EngineCapabilities } from '../capabilities'

export const DSH_CAPABILITIES: EngineCapabilities = {
  engineId: 'dsh',
  displayName: 'DeepSeek Harness',
  streaming: {
    // `assistant/chunk` replays raw provider stream chunks — `text-delta`,
    // `reasoning-delta` and `tool-call-delta` — so all three are token-level.
    text: 'token',
    reasoning: 'token',
    toolInput: 'token',
    // `tool/result` is emitted once, on completion — no incremental output
    // channel exists in the session vocabulary (not even for shell).
    toolOutput: 'final-only',
  },
  tools: {
    native: [],
    // `from` values are the runtime's registered tool names, mirroring the
    // normalizer's rename table. `lossy` is true across the board: argument
    // and result shapes are the harness's own, so the CC-shaped rewrite is a
    // best-effort projection rather than a field-for-field match.
    //
    // Only names the composition in `runtime/cordis-config.ts` actually
    // mounts appear here; a mapping for a tool the runtime never registers
    // would be documentation of an intention, not of behaviour.
    // The six `terminal_*` tools are deliberately absent: only `terminal_send`
    // resembles a shell run, and rendering `terminal_list` or `terminal_close`
    // as one would misdescribe them. They fall through to the generic card.
    synthetic: [
      { kind: 'Bash', from: 'bash', lossy: true },
      { kind: 'Read', from: 'read', lossy: true },
      { kind: 'Write', from: 'write', lossy: true },
      { kind: 'Edit', from: 'edit', lossy: true },
      { kind: 'Edit', from: 'str_replace_editor', lossy: true },
      { kind: 'Grep', from: 'grep', lossy: true },
      { kind: 'Glob', from: 'glob', lossy: true },
      { kind: 'WebSearch', from: 'web_search', lossy: true },
      { kind: 'WebFetch', from: 'web_fetch', lossy: true },
      { kind: 'TodoWrite', from: 'todo_write', lossy: true },
      { kind: 'Task', from: 'subagent', lossy: true },
      { kind: 'Skill', from: 'skill', lossy: true },
    ],
    shellHeuristics: false,
  },
  // `todo/write` is a whole-list snapshot of three-state entries with no
  // stable id and no activeForm label.
  todo: { states: ['pending', 'in_progress', 'completed'], hasActiveForm: false },
  // `subagent.started` / `subagent.finished` carry the lineage edges, and the
  // adapter tags descendant session events with their parent tool call, so
  // the timeline gets the same structure CC provides. `finished` is only
  // emitted for in-process children; out-of-process ones end silently.
  subAgent: { model: 'declarative', visibleLifecycle: true },
  features: {
    // The composition mounts the runtime's filesystem skill provider pointed
    // at Halo's own skill roots. The runtime's frontmatter contract is
    // narrower than Claude Code's, so a skill with no `name` or a name that is
    // not kebab-case is skipped — see `runtime/cordis-config.ts`.
    skills: true,
    // Both kinds reach the model: external servers are handed to the runtime's
    // MCP client, and Halo's in-process servers are published on loopback for
    // it to dial. The absent server→client channel constrains approvals, not
    // tool availability.
    mcp: true,
    hooks: false,
    // A prior session id can be replayed, but the runtime creates the session
    // lazily and restores no history unless a deployment composes persistence,
    // so a resumed conversation is not guaranteed to keep its context.
    // Provider, model and cwd are pinned for the life of the process.
    sessionResume: false,
    // A prompt is a durable enqueue receipt with no relationship to the turn
    // in flight, so Halo cannot promise the message lands in it.
    midTurnInjection: false,
    // No cancel method. Stopping means killing the runtime and losing the
    // session with it — a restart, not an interrupt.
    interrupt: false,
    // Harness image blocks reference attachments the runtime owns; Halo
    // cannot mint one from a pasted payload, so images are dropped on send.
    multimodalImage: false,
    contextCompaction: false,
    // No approval or elicitation channel exists in either direction.
    askUserQuestion: false,
  },
}
