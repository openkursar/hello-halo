/**
 * @module commands/built-in
 *
 * Aggregator for the SDK's built-in slash command set.
 *
 * Each command is a metadata-only declaration in its own file. The order of
 * the array below is the canonical display order — hosts that don't sort
 * autocomplete entries fall back to this list, so keep it alphabetical.
 *
 * Adding a new built-in command requires three steps:
 *   1. Create `built-in/<name>.ts` exporting a `Command`.
 *   2. Add the import + array entry below in alphabetical order.
 *   3. Update `registry.test.ts` if the command exposes a new field shape.
 *
 * The set is intentionally narrow: a host application will surface much of
 * this in its own UI. Only commands that stay meaningful as `/<name>` text
 * input belong here.
 */

import type { Command } from '../types.js';

import clear from './clear.js';
import compact from './compact.js';
import context from './context.js';
import cost from './cost.js';
import help from './help.js';
import init from './init.js';
import mcp from './mcp.js';
import model from './model.js';
import status from './status.js';
import usage from './usage.js';

/**
 * The frozen built-in command list.
 *
 * Alphabetical by canonical name. Consumers should never mutate this array
 * directly; the {@link CommandRegistry} returns its own copies.
 */
export const BUILT_IN_COMMANDS: readonly Command[] = Object.freeze([
  clear,
  compact,
  context,
  cost,
  help,
  init,
  mcp,
  model,
  status,
  usage,
]);

/** Set of canonical built-in names + aliases. Used by hosts to badge entries. */
export const BUILT_IN_COMMAND_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(
    BUILT_IN_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
  ),
);
