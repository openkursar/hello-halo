/**
 * @module commands/dispatch/executor
 *
 * In-process slash command dispatcher.
 *
 * Resolves a parsed invocation against a {@link CommandRegistry}, applies the
 * user-invocability filter, and runs the matching executor. Returns a
 * structured {@link DispatchOutcome} describing how the caller should react:
 *
 *   - `local-result`        : a `local` command returned a system-message payload.
 *                              The caller should yield it and close the turn
 *                              WITHOUT invoking the LLM.
 *   - `prompt-replacement`  : a `prompt` command produced replacement
 *                              `MessageParam`s. The caller should substitute
 *                              the user's input and continue the normal query
 *                              loop.
 *   - `host-handled`        : the command is registered but exposes no executor.
 *                              The caller should forward to the host (renderer),
 *                              which intercepts the input separately.
 *                              advertises commands and the renderer runs them.
 *   - `unknown`             : no command with this name exists.
 *   - `disabled`            : the command exists but fails its
 *                              `isEnabled` / `userInvocable` gate.
 *
 * An `unknown` name is not a command: the caller forwards the input to the
 * LLM verbatim as an ordinary user message. A `disabled` command is one the
 * user did name, so the caller explains why it cannot run.
 */

import type { Message } from '../../types/provider.js';
import type { CommandRegistry } from '../registry.js';
import {
  type Command,
  type SlashCommandContext,
  type SlashCommandResult,
} from '../types.js';

/** Dispatch outcome variants. See module doc-comment. */
export type DispatchOutcome =
  | { kind: 'local-result'; command: Command; result: SlashCommandResult }
  | { kind: 'prompt-replacement'; command: Command; messages: Message[] }
  | { kind: 'host-handled'; command: Command }
  | { kind: 'unknown' }
  | { kind: 'disabled'; command: Command };

/**
 * Resolve and execute a slash command.
 *
 * @param registry         Per-session command registry.
 * @param name             Parsed canonical name (from {@link parseSlashInvocation}).
 * @param args             Trimmed argument string. Empty when none.
 * @param ctx              Execution context bound by the session.
 */
export async function dispatchSlashCommand(
  registry: CommandRegistry,
  name: string,
  args: string,
  ctx: SlashCommandContext,
): Promise<DispatchOutcome> {
  const command = registry.get(name);
  if (!command) return { kind: 'unknown' };

  // Re-evaluate invocability at dispatch time. Commands marked
  // `userInvocable: false` are gated here — they cannot be dispatched.
  // `isHidden` is NOT checked: hidden commands can still be invoked
  // directly; they are only omitted from autocomplete listings.
  if (command.userInvocable === false) return { kind: 'disabled', command };
  if (command.isEnabled && !command.isEnabled()) return { kind: 'disabled', command };

  if (command.type === 'local') {
    if (typeof command.call !== 'function') {
      return { kind: 'host-handled', command };
    }
    const result = await command.call(args, ctx);
    return { kind: 'local-result', command, result };
  }

  // Prompt command
  if (typeof command.getPromptForCommand !== 'function') {
    return { kind: 'host-handled', command };
  }
  const messages = await command.getPromptForCommand(args, ctx);
  return { kind: 'prompt-replacement', command, messages };
}
