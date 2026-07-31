/**
 * useStoreCollections — reads curated scene collections, shared once per session
 * (see lib/store-resources), gated by the `enabled` flag (set when the discover
 * layout includes a collections section). Returns an empty list until loaded or
 * when unavailable, so the discover page simply omits the collections block.
 */

import { storeCollectionsResource } from '../lib/store-resources'
import type { StoreCollection } from '../../shared/store/store-types'

const EMPTY: StoreCollection[] = []

export function useStoreCollections(enabled: boolean): StoreCollection[] {
  return storeCollectionsResource.useValue(EMPTY, enabled)
}
