/**
 * Publish author persistence.
 *
 * The author handle becomes the user's namespace in the store
 * (e.g. `author/app-name`). It is the same across every share flow, so we
 * remember the last value the user entered and reuse it as the default.
 */

const AUTHOR_STORAGE_KEY = 'halo:publish-author'

/** Load the last author the user published under, or '' if none. */
export function loadStoredAuthor(): string {
  return localStorage.getItem(AUTHOR_STORAGE_KEY) || ''
}

/** Remember the author for future share flows. No-op for blank input. */
export function saveAuthor(author: string): void {
  const trimmed = author.trim()
  if (trimmed) localStorage.setItem(AUTHOR_STORAGE_KEY, trimmed)
}
