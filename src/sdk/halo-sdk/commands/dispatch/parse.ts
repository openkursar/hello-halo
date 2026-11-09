/**
 * @module commands/dispatch/parse
 *
 * Slash invocation parser.
 *
 * Recognises the `/<name> [args]` shape on the FIRST line of user input and
 * returns the canonical name plus the trimmed arguments. Multi-line input that begins with a slash
 * command is supported (subsequent lines are NOT part of `args`; they remain
 * in the original user input for downstream handling, but the dispatcher only
 * looks at the first line for routing).
 */

/** Successful parse result. */
export interface SlashInvocation {
  /** Canonical command name (no leading slash). */
  name: string;
  /** Trimmed argument string. Empty when no args were supplied. */
  args: string;
}

/**
 * Match `^/([^\s/]+)(?:\s+(.*))?$` against the FIRST line.
 *
 * Returns `null` when:
 *   - Input is empty / whitespace-only
 *   - First line does not start with `/`
 *   - The slash is followed by whitespace, a second slash, or nothing
 *   - The name runs into another `/` (a path such as `/tmp/a.log`)
 */
export function parseSlashInvocation(input: string): SlashInvocation | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Only the first line is considered for routing.
  const firstLineEnd = trimmed.indexOf('\n');
  const firstLine =
    firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd).trimEnd();

  if (!firstLine.startsWith('/')) return null;

  // Reject double-slash (e.g. `//foo` or URLs pasted at start).
  if (firstLine.startsWith('//')) return null;

  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(firstLine);
  if (!match) return null;

  const name = match[1];
  if (!name) return null;

  const args = (match[2] ?? '').trim();
  return { name, args };
}
