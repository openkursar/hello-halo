/**
 * @module commands/types
 *
 * Slash command metadata and executable contract.
 *
 * A command is either `local` (handled in-process, no model call; returns a
 * {@link SlashCommandResult}) or `prompt` (expands into messages that replace
 * the user's input before the normal query loop runs).
 *
 * `call` and `getPromptForCommand` are optional. Without an executor the
 * dispatcher reports the command as host-handled; see
 * `commands/dispatch/executor.ts`.
 */

import type { Message } from '../types/provider.js';
import type { SlashCommand } from '../types/config.js';

/** Where a command came from; hosts may use it to badge autocomplete entries. */
export type CommandSource = 'builtin' | 'user';

/** Discriminator for command execution shape. */
export type CommandKind = 'local' | 'prompt';

/**
 * Structured output of a `local` command.
 *
 * The dispatcher renders this into a synthetic system SDK message. Markdown
 * is the canonical body — hosts that do not render markdown should display
 * the text verbatim.
 */
export interface SlashCommandResult {
  kind: 'system';
  /** Markdown / plain-text payload to surface to the user. */
  markdown: string;
}

/**
 * Cumulative cost / usage snapshot for the current session.
 *
 * Aggregated by `core/session.ts` from each turn's `result` event so handlers
 * (`/cost`, `/usage`) can render running totals without owning a tracker
 * themselves. The query-loop's per-turn `CostTracker` resets each turn — this
 * snapshot is the session-lifetime view.
 */
export interface SessionCostSnapshot {
  /** Total USD spent across all completed turns this session. */
  totalCostUsd: number;
  /** Total wall-clock duration (ms) summed across completed turns. */
  totalDurationMs: number;
  /** Total API time (ms) summed across completed turns. */
  totalApiDurationMs: number;
  /** Total turns counted (one per `result` event). */
  numTurns: number;
  /** Cumulative token usage. */
  tokens: {
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
  };
}

/**
 * Minimal execution context exposed to slash command handlers.
 *
 * Designed to surface *only* the session state a built-in command actually
 * needs. Implementations should never leak the full SessionState — pass
 * focused getters/setters and the dispatcher binds them per-invocation.
 */
export interface SlashCommandContext {
  /** Current session id. */
  readonly sessionId: string;
  /** Current working directory (effective `cwd` for the session). */
  readonly cwd: string;
  /** Currently active model. */
  readonly model: string;
  /** Override the model for subsequent turns. Mirrors `SDKSession.setModel`. */
  setModel(model: string): void;
  /** Snapshot of MCP server connection statuses. */
  readonly mcpServerStatuses: ReadonlyArray<{ name: string; status: string }>;
  /**
   * Read-only snapshot of the session's message history at dispatch time.
   *
   * Handlers that need to count/inspect prior turns (e.g. `/cost`,
   * `/context`) operate on this snapshot. The slice is shallow-frozen by
   * the dispatcher.
   */
  readonly messages: readonly Message[];
  /**
   * Clear the session's message history. Used by `/clear`. Implementations
   * MUST also reset any per-turn caches the dispatcher may have created.
   * Persistent owners resolve only after replacement history is saved.
   */
  clearMessages(): void | Promise<void>;
  /**
   * Trigger a manual compaction of the session. Used by `/compact`.
   * Returns when the compaction has been kicked off; the dispatcher does
   * not await full completion.
   */
  compactSession(instructions?: string): Promise<void>;
  /**
   * Session-lifetime cost snapshot — aggregated from each turn's `result`
   * event. Used by `/cost` and `/usage`. The returned object is a fresh
   * frozen copy at call time; handlers should treat it as immutable.
   *
   * Note: only completed turns contribute. The CURRENT in-flight turn (the
   * one that triggered the slash command) is not yet aggregated because
   * its `result` event has not been emitted.
   */
  getCostSnapshot(): SessionCostSnapshot;
  /**
   * Pre-filtered, user-invocable command list at dispatch time. Used by
   * `/help` to enumerate available commands without re-reading
   * BUILT_IN_COMMANDS (which would miss user/skill overlays).
   *
   * Already filtered through `filterUserInvocable`, so handlers can render
   * the list verbatim.
   */
  readonly commands: ReadonlyArray<Command>;
}

/**
 * Common metadata fields shared by every command kind.
 */
export interface CommandBase {
  /** Canonical name (without leading slash). */
  name: string;
  /** One-line user-facing summary. */
  description: string;
  /** Alternative invocation names. */
  aliases?: string[];
  /** Hint string rendered after the command in the autocomplete (e.g. `<topic>`). */
  argumentHint?: string;
  /** Detailed scenarios — surfaced by `/help` and skill listings. */
  whenToUse?: string;
  /** Defaults to true. Override for feature-flag/env-gated commands. */
  isEnabled?: () => boolean;
  /** Defaults to false. When true, hidden from autocomplete and `/help`. */
  isHidden?: boolean;
  /** Defaults to true. When false, the command is model-only and never shown. */
  userInvocable?: boolean;
  /** Provenance — used by hosts to badge entries. */
  source?: CommandSource;
}

/**
 * Locally-handled command — execution returns a structured result that the
 * dispatcher surfaces to the user without invoking the LLM.
 *
 * `call` is optional: when omitted, the SDK treats the command as host-handled
 * (the renderer or main process intercepts the input separately). Commands
 * with a handler execute inside the SDK.
 */
export interface LocalCommand extends CommandBase {
  type: 'local';
  /**
   * In-process executor. When present, the dispatcher invokes it and yields
   * a synthetic system message carrying the result; the LLM is NOT called.
   */
  call?: (args: string, ctx: SlashCommandContext) => Promise<SlashCommandResult>;
}

/**
 * Prompt-expansion command — expands into user-message blocks that REPLACE
 * the user's input. The normal query loop then runs against those blocks.
 *
 * `getPromptForCommand` is optional: when omitted, the SDK treats the
 * command as host-expanded (the host substitutes the prompt before the
 * input ever reaches the SDK). Skill-derived prompt commands always
 * supply an expansion.
 */
export interface PromptCommand extends CommandBase {
  type: 'prompt';
  /**
   * Build the user-message replacement for this command. When present, the
   * dispatcher uses the returned blocks instead of the original `/cmd …` input.
   */
  getPromptForCommand?: (args: string, ctx: SlashCommandContext) => Promise<Message[]>;
}

/** Discriminated union of all command kinds. */
export type Command = LocalCommand | PromptCommand;

export function getCommandName(cmd: CommandBase): string {
  return cmd.name;
}

export function isCommandEnabled(cmd: CommandBase): boolean {
  return cmd.isEnabled?.() ?? true;
}

/** Type guard — true when the value is a structurally valid `Command`. */
export function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Command>;
  return (
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    (v.type === 'local' || v.type === 'prompt')
  );
}

/**
 * Project a {@link Command} onto the wire-format {@link SlashCommand}.
 *
 * The wire format only carries the fields hosts need to render an
 * autocomplete entry — name, description, optional argument hint.
 */
export function toSlashCommand(cmd: Command): SlashCommand {
  const wire: SlashCommand = {
    name: getCommandName(cmd),
    description: cmd.description,
  };
  if (cmd.argumentHint) wire.argumentHint = cmd.argumentHint;
  return wire;
}
