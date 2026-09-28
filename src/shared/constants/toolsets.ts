/**
 * Which toolsets a space conversation starts with.
 *
 * Shared because the main process stamps these onto new conversations and the
 * composer treats them as the quiet baseline: only a capability enabled beyond
 * this set is surfaced next to the "+" button. Ids match the toolset registry
 * (services/agent/toolsets); an id unavailable on this platform is dropped at
 * use time.
 */
export const DEFAULT_TOOLSETS: readonly string[] = ['ai-browser', 'halo-team']

/**
 * The defaults every existing install had already been offered before
 * `toolsetDefaultsSeen` was recorded.
 */
const LEGACY_SEEN_DEFAULTS: readonly string[] = ['ai-browser']

/**
 * Carries a saved last-used selection forward when a toolset becomes a default.
 *
 * A saved selection is the user's own choice and stays authoritative, but a
 * default the user has never been offered is not something they declined, so
 * it is added once. Recording it as seen means turning it off afterwards
 * sticks.
 */
export function applyNewToolsetDefaults(
  lastToolsets: string[] | undefined,
  seen: string[] | undefined,
): { lastToolsets: string[] | undefined; seen: string[] } {
  const alreadySeen = new Set(seen ?? LEGACY_SEEN_DEFAULTS)
  const unseen = DEFAULT_TOOLSETS.filter(id => !alreadySeen.has(id))
  const nextSeen = [...alreadySeen, ...unseen]
  if (!Array.isArray(lastToolsets)) return { lastToolsets, seen: nextSeen }
  const added = unseen.filter(id => !lastToolsets.includes(id))
  return { lastToolsets: [...lastToolsets, ...added], seen: nextSeen }
}
