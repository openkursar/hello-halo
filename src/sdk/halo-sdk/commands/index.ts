/**
 * @module commands
 *
 * Public entry point for the SDK's slash command subsystem.
 *
 * Architecture:
 *   - {@link CommandRegistry}      — mutable in-memory registry (per session)
 *   - {@link BUILT_IN_COMMANDS}    — frozen list seeded into every registry
 *   - {@link mergeUserCommands}    — overlay caller-supplied commands
 *   - {@link toSlashCommandList}   — project to wire-format `SlashCommand[]`
 *
 * Hosts (`query()`, `createSession()`) instantiate a registry per session,
 * apply caller overlays, and project the user-invocable subset into the
 * `system/init` event and `Query.supportedCommands()` control method.
 */

import type { SlashCommand } from '../types/config.js';

import { BUILT_IN_COMMANDS, BUILT_IN_COMMAND_NAMES } from './built-in/index.js';
import { filterUserInvocable } from './filter.js';
import {
  CommandRegistry,
  createSessionRegistry,
  globalRegistry,
  resolveCommand,
} from './registry.js';
import {
  type Command,
  type CommandBase,
  type CommandKind,
  type CommandSource,
  type LocalCommand,
  type PromptCommand,
  type SessionCostSnapshot,
  type SlashCommandContext,
  type SlashCommandResult,
  getCommandName,
  isCommand,
  isCommandEnabled,
  toSlashCommand,
} from './types.js';
import { parseSlashInvocation, type SlashInvocation } from './dispatch/parse.js';
import {
  dispatchSlashCommand,
  type DispatchOutcome,
} from './dispatch/executor.js';
import {
  loadSkillCommands,
  type LoadSkillCommandsOptions,
} from './sources/skills.js';

// ---------------------------------------------------------------------------
// Re-exports — the public surface of the commands subsystem
// ---------------------------------------------------------------------------

export {
  BUILT_IN_COMMANDS,
  BUILT_IN_COMMAND_NAMES,
  CommandRegistry,
  createSessionRegistry,
  dispatchSlashCommand,
  filterUserInvocable,
  getCommandName,
  globalRegistry,
  isCommand,
  isCommandEnabled,
  loadSkillCommands,
  parseSlashInvocation,
  resolveCommand,
  toSlashCommand,
};

export type {
  Command,
  CommandBase,
  CommandKind,
  CommandSource,
  DispatchOutcome,
  LoadSkillCommandsOptions,
  LocalCommand,
  PromptCommand,
  SessionCostSnapshot,
  SlashCommandContext,
  SlashCommandResult,
  SlashInvocation,
};

// ---------------------------------------------------------------------------
// High-level helpers used by query() and createSession()
// ---------------------------------------------------------------------------

/**
 * Returns a frozen copy of the built-in command set.
 *
 * The result is safe to share across sessions — mutating it will throw
 * because the underlying array is frozen.
 */
export function getBuiltInCommands(): readonly Command[] {
  return BUILT_IN_COMMANDS;
}

/**
 * Coerces a heterogeneous caller-supplied list into normalized {@link Command}
 * metadata.
 *
 * Inputs may be:
 *   - a plain string (treated as a `local` command with no description)
 *   - a {@link SlashCommand} wire object (`name` / `description` / `argumentHint`)
 *   - a fully-typed {@link Command}
 *
 * Anything that fails minimal validation is dropped (with a console warning),
 * so a malformed entry never poisons the entire registry.
 */
export function normalizeUserCommands(
  input: ReadonlyArray<string | SlashCommand | Command> | undefined,
): Command[] {
  if (!input || input.length === 0) return [];
  const out: Command[] = [];
  for (const entry of input) {
    if (typeof entry === 'string') {
      const name = entry.trim();
      if (!name) continue;
      out.push({
        type: 'local',
        name,
        description: '',
        source: 'user',
      });
      continue;
    }

    if (!entry || typeof entry !== 'object') continue;

    if (isCommand(entry)) {
      out.push({ ...entry, source: entry.source ?? 'user' });
      continue;
    }

    const wire = entry as SlashCommand;
    if (typeof wire.name !== 'string' || !wire.name.trim()) continue;
    out.push({
      type: 'local',
      name: wire.name,
      description: wire.description ?? '',
      argumentHint: wire.argumentHint,
      source: 'user',
    });
  }
  return out;
}

/**
 * Inputs for {@link buildSessionRegistry}.
 *
 * Layering rule (later overrides earlier on name collision):
 *
 *     builtin  →  skills  →  user
 *
 * Skills are typically produced by {@link loadSkillCommands}; user is
 * `Options.slashCommands` from the public SDK surface.
 */
export interface BuildSessionRegistryOptions {
  /** Caller-supplied commands. Overrides skills and built-ins on collision. */
  user?: ReadonlyArray<string | SlashCommand | Command>;
  /** Skill-derived commands. Overrides built-ins on collision. */
  skills?: ReadonlyArray<Command>;
}

/**
 * Builds the command registry for one session.
 *
 * Built-ins are seeded first; skill commands are layered next; caller-supplied
 * commands are layered last (last-write-wins on name collision).
 *
 * Backward compatibility: callers may pass the legacy positional argument
 * (the user-commands list) directly. New call sites should prefer the
 * options object form for clarity.
 */
export function buildSessionRegistry(
  input?:
    | BuildSessionRegistryOptions
    | ReadonlyArray<string | SlashCommand | Command>,
): CommandRegistry {
  const opts = normalizeBuildInput(input);
  const reg = createSessionRegistry();
  if (opts.skills) {
    for (const cmd of opts.skills) reg.register(cmd);
  }
  for (const cmd of normalizeUserCommands(opts.user)) reg.register(cmd);
  return reg;
}

function normalizeBuildInput(
  input?:
    | BuildSessionRegistryOptions
    | ReadonlyArray<string | SlashCommand | Command>,
): BuildSessionRegistryOptions {
  if (input == null) return {};
  if (Array.isArray(input)) {
    // Legacy positional form: user commands only.
    return { user: input as ReadonlyArray<string | SlashCommand | Command> };
  }
  return input as BuildSessionRegistryOptions;
}

/**
 * Projects a list of {@link Command} entries onto the wire-format
 * {@link SlashCommand} array — `name` / `description` / optional
 * `argumentHint`.
 */
export function toSlashCommandList(commands: readonly Command[]): SlashCommand[] {
  return commands.map(toSlashCommand);
}

/**
 * Convenience: project the user-invocable subset of a registry onto the
 * wire format. Used by `Query.supportedCommands()` and
 * `Query.initializationResult()`.
 */
export function listUserInvocableSlashCommands(registry: CommandRegistry): SlashCommand[] {
  return toSlashCommandList(registry.listUserInvocable());
}

/**
 * Convenience: project the user-invocable subset of a registry onto a flat
 * `string[]` of canonical names. Used by the `system/init` event.
 */
export function listUserInvocableNames(registry: CommandRegistry): string[] {
  return registry.listUserInvocable().map(getCommandName);
}
