/**
 * Tells clients when what they list about AI sources changed, whoever saved it:
 * a login from a remote client, a catalog refresh, a deletion. Token renewals
 * also save sources but change nothing a client shows, so they stay silent.
 */

import type { AISourcesConfig, ModelCatalogChangedEvent } from '../../../shared/types'
import { getConfig, onAiSourcesConfigChange } from '../../foundation/config.service'

const CURRENT_KEY = '\0current'

/** Credentials and timestamps change on every renewal without changing the listing. */
function listingOf(sources: AISourcesConfig | undefined): Map<string, string> {
  const listing = new Map<string, string>()
  for (const source of sources?.sources ?? []) {
    const { apiKey: _apiKey, accessToken: _accessToken, refreshToken: _refreshToken, tokenExpires: _tokenExpires, updatedAt: _updatedAt, ...shown } = source
    listing.set(source.id, JSON.stringify(shown))
  }
  for (const group of sources?.groups ?? []) listing.set(group.id, JSON.stringify(group))
  listing.set(CURRENT_KEY, sources?.currentId ?? '')
  return listing
}

/** Ids of sources and groups whose listing differs; the selection counts for the old and new pick. */
function listedChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>()
  for (const [id, entry] of after) {
    if (id !== CURRENT_KEY && before.get(id) !== entry) changed.add(id)
  }
  for (const id of before.keys()) {
    if (!after.has(id)) changed.add(id)
  }
  const previous = before.get(CURRENT_KEY)
  const current = after.get(CURRENT_KEY)
  if (previous !== current) {
    if (previous) changed.add(previous)
    if (current) changed.add(current)
  }
  return [...changed]
}

/** Calls `onChange` after each successful save that changed the listing. Returns the unsubscribe. */
export function watchListedSources(onChange: (event: ModelCatalogChangedEvent) => void): () => void {
  let listing = listingOf(getConfig().aiSources)
  return onAiSourcesConfigChange(next => {
    const nextListing = listingOf(next)
    const sourceIds = listedChanges(listing, nextListing)
    listing = nextListing
    if (sourceIds.length > 0) onChange({ sourceIds })
  })
}
