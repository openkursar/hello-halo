/**
 * Thought panels currently expanded on screen, by message id. The loaded
 * thoughts budget (`backend/cache.ts cacheLoadedThoughts`) never drops these:
 * dropping them would collapse a panel the user is reading.
 */

const holders = new Map<string, number>()

/** Held while an expanded panel for `messageId` is mounted; returns the release. */
export function holdOpenThoughts(messageId: string): () => void {
  holders.set(messageId, (holders.get(messageId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (holders.get(messageId) ?? 1) - 1
    if (left > 0) holders.set(messageId, left)
    else holders.delete(messageId)
  }
}

export function isThoughtsPanelOpen(messageId: string): boolean {
  return holders.has(messageId)
}
