/**
 * useDiscoverLayout — resolves the config-driven discover-page layout.
 *
 * The layout is resolved in the main process (`server ?? built-in`) and shared
 * once per session (see lib/store-resources). Until it loads — or if it fails —
 * the built-in catalog-only layout is used, so the discover page always renders.
 * A store refresh invalidates the cache and pushes the fresh layout to consumers.
 */

import { discoverLayoutResource } from '../lib/store-resources'
import { BUILTIN_DISCOVER_LAYOUT } from '../../shared/store/store-types'
import type { DiscoverLayout } from '../../shared/store/store-types'

export function useDiscoverLayout(): DiscoverLayout {
  return discoverLayoutResource.useValue(BUILTIN_DISCOVER_LAYOUT)
}
