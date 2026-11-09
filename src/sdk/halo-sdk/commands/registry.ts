/**
 * @module commands/registry
 *
 * In-memory slash command registry.
 *
 *   - The registry holds {@link Command} metadata only.
 *   - List operations evaluate `isEnabled()` lazily so state changes
 *     (feature flags) take effect without re-creating the registry.
 *   - Built-in commands are seeded eagerly; plugins / skills / user-supplied
 *     commands are layered on top via `register()`.
 *
 * Two registry surfaces exist:
 *
 *   - {@link CommandRegistry}  : the class — instantiated per session/query.
 *   - {@link globalRegistry}   : a process-wide singleton seeded with the
 *                                built-in command set, useful for tests and
 *                                ad-hoc lookups outside a session.
 *
 * Lookup is case-insensitive on the canonical name and aliases.
 */

import { BUILT_IN_COMMANDS } from './built-in/index.js';
import {
  type Command,
  getCommandName,
} from './types.js';
import { filterUserInvocable } from './filter.js';

/**
 * Snapshot of registry contents — returned by all read methods.
 *
 * The array is a frozen copy to prevent external mutation of internal state.
 */
export type CommandList = readonly Command[];

/**
 * Mutable registry of slash commands.
 *
 * The registry is the single source of truth for which commands the SDK
 * advertises. Hosts may instantiate per-query registries (recommended) or
 * use {@link globalRegistry} for process-wide registration.
 */
export class CommandRegistry {
  /** Canonical name → Command. Lowercased for case-insensitive lookup. */
  private readonly byName = new Map<string, Command>();
  /** Alias → canonical name. Lowercased. */
  private readonly aliasIndex = new Map<string, string>();

  constructor(initial: readonly Command[] = []) {
    for (const cmd of initial) this.register(cmd);
  }

  /**
   * Registers a command, replacing any existing command with the same name.
   *
   * Aliases are also indexed; conflicting aliases map to the most recently
   * registered command (last-write-wins).
   */
  register(cmd: Command): void {
    const key = cmd.name.toLowerCase();

    const previous = this.byName.get(key);
    if (previous) this.removeAliasesOf(previous);

    this.byName.set(key, cmd);

    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.aliasIndex.set(alias.toLowerCase(), key);
      }
    }
  }

  /**
   * Removes a command by canonical name. Returns true when a command was
   * removed, false when no command with that name was registered.
   */
  unregister(name: string): boolean {
    const key = name.toLowerCase();
    const existing = this.byName.get(key);
    if (!existing) return false;
    this.removeAliasesOf(existing);
    this.byName.delete(key);
    return true;
  }

  /**
   * Resolves a command by canonical name or alias. Lookup is
   * case-insensitive. Returns `undefined` when no match exists.
   */
  get(name: string): Command | undefined {
    const key = name.toLowerCase();
    const direct = this.byName.get(key);
    if (direct) return direct;
    const aliased = this.aliasIndex.get(key);
    return aliased ? this.byName.get(aliased) : undefined;
  }

  /** Returns true when a command with the given name or alias is registered. */
  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /**
   * Returns every registered command, in registration order.
   *
   * The result is a new readonly array; callers may not mutate it.
   */
  list(): CommandList {
    return Object.freeze([...this.byName.values()]);
  }

  /**
   * Returns the user-invocable subset of registered commands, applying
   * `isEnabled`, `isHidden`, and `userInvocable` filters.
   */
  listUserInvocable(): CommandList {
    return Object.freeze(filterUserInvocable(this.list()));
  }

  /** Number of commands currently registered. */
  size(): number {
    return this.byName.size;
  }

  /** Removes every command. Intended for tests. */
  clear(): void {
    this.byName.clear();
    this.aliasIndex.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private removeAliasesOf(cmd: Command): void {
    if (!cmd.aliases) return;
    const ownerKey = cmd.name.toLowerCase();
    for (const alias of cmd.aliases) {
      const aliasKey = alias.toLowerCase();
      if (this.aliasIndex.get(aliasKey) === ownerKey) {
        this.aliasIndex.delete(aliasKey);
      }
    }
  }
}

/**
 * Process-wide registry seeded with the SDK's built-in command set.
 *
 * Use this for tests or one-off lookups; production code should prefer
 * per-session registries built via {@link createSessionRegistry}.
 */
export const globalRegistry: CommandRegistry = new CommandRegistry(
  BUILT_IN_COMMANDS,
);

/**
 * Builds a fresh registry seeded with built-ins plus any caller-supplied
 * user commands. Caller commands replace built-ins on name collision.
 */
export function createSessionRegistry(
  userCommands: readonly Command[] = [],
): CommandRegistry {
  const reg = new CommandRegistry(BUILT_IN_COMMANDS);
  for (const cmd of userCommands) reg.register(cmd);
  return reg;
}

/**
 * Resolves a command from a registry by either its canonical name or alias.
 *
 * Convenience wrapper for name-or-alias resolution.
 */
export function resolveCommand(
  registry: CommandRegistry,
  name: string,
): Command | undefined {
  return registry.get(name);
}

/**
 * Resolves the canonical user-facing name for a command, falling back to the
 * structural `name` field. Re-exported here so callers can build wire
 * payloads without importing from `./types`.
 */
export { getCommandName };
