import { type Command, isCommandEnabled } from './types.js';

/**
 * Returns the subset of commands eligible to appear in user-facing
 * autocomplete and the `system/init` `slash_commands` array.
 *
 * A command passes when all of the following hold:
 *   - `userInvocable !== false`
 *   - `isHidden !== true`
 *   - `isEnabled()` returns true (default true)
 */
export function filterUserInvocable(commands: readonly Command[]): Command[] {
  return commands.filter(
    (c) => c.userInvocable !== false && c.isHidden !== true && isCommandEnabled(c),
  );
}
