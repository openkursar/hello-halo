/**
 * useDiscoverPage — the whole discover page, resolved by the main process and
 * shared once per session (see lib/store-resources).
 *
 * `undefined` while loading and `null` when it could not be resolved, kept
 * distinct so the page can hold still instead of flashing an empty state.
 */

import { discoverPageResource } from '../lib/store-resources'
import type { ResolvedDiscover } from '../../shared/store/store-types'

export function useDiscoverPage(): ResolvedDiscover | null | undefined {
  return discoverPageResource.useValue(undefined)
}
