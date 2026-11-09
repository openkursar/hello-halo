/**
 * @module tools/bash/shellQuote
 * @license MIT
 */

/** Encode one argument for a POSIX shell; the input must not contain NUL. */
export function posixQuote(s: string): string {
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}

/**
 * Quote an array of arguments into a single shell-safe string.
 * Each element is independently quoted; joined with spaces.
 */
export function posixQuoteArgs(args: ReadonlyArray<string>): string {
  return args.map(posixQuote).join(' ');
}
