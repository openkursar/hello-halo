/**
 * Pure helpers for typecheck-changed.mjs (kept apart so tests can import them
 * without running the script).
 */

/** File paths from `git status --porcelain` output: renames resolve to their new path, quotes are dropped. */
export function parsePorcelain(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    // Renames read as "old -> new"; only the new path can have errors.
    .map((path) => (path.includes(' -> ') ? path.split(' -> ')[1] : path))
    .map((path) => path.replace(/^"|"$/g, ''))
}
