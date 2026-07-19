/**
 * useSecurityPolicy — renderer-side accessor for the build's security
 * policy flags.
 *
 * The policy is sourced from `product.json` in the main process and is
 * immutable for the lifetime of the process — there is no way to flip a
 * flag at runtime. The hook therefore:
 *
 *   1. Fetches once per renderer process and caches the result in a
 *      module-level promise so concurrent callers share a single round
 *      trip.
 *   2. Returns `null` while the first fetch is in flight. Consumers
 *      should treat `null` as "policy unknown — render the permissive
 *      default" (i.e. show the feature) so a brief network blip on the
 *      remote/web transport doesn't cause UI flashes that lock features
 *      that aren't actually disabled.
 *   3. Falls back to the permissive default when the fetch fails
 *      (e.g. older main process without the IPC). Failing closed would
 *      brick legitimate desktop builds during a partial upgrade.
 *
 * Anything stricter than "permissive default on read failure" must be
 * enforced server-side — the renderer-side gate is a UX layer, not a
 * security boundary.
 */

import { useEffect, useState } from 'react'
import { api } from '../api'

/**
 * Shape returned by `security:get-public-policy`. Mirrors
 * `PublicSecurityPolicy` in `src/main/services/security-policy.ts`.
 *
 * Kept as a renderer-local copy on purpose: the main and renderer
 * processes live in different module graphs and we don't want renderer
 * code reaching into main-process modules.
 */
export interface PublicSecurityPolicy {
  tunnelSafe: boolean
  /** True when the build allows users to extend the browser allowlist.
   *  Gates the Settings allowlist editor and the blocked-page
   *  "allow and retry" action. */
  browserAllowlistEditable: boolean
}

/** Permissive defaults applied while the policy is loading or on error. */
const PERMISSIVE_DEFAULT: PublicSecurityPolicy = {
  tunnelSafe: false,
  browserAllowlistEditable: false,
}

let cached: Promise<PublicSecurityPolicy> | null = null

async function fetchPolicy(): Promise<PublicSecurityPolicy> {
  try {
    const res = await api.getSecurityPolicy()
    if (res.success && res.data && typeof res.data === 'object') {
      const data = res.data as Partial<PublicSecurityPolicy>
      return {
        tunnelSafe: data.tunnelSafe === true,
        browserAllowlistEditable: data.browserAllowlistEditable === true,
      }
    }
    console.warn('[useSecurityPolicy] Empty/invalid response, using permissive default')
    return PERMISSIVE_DEFAULT
  } catch (error) {
    console.error('[useSecurityPolicy] Fetch failed, using permissive default:', error)
    return PERMISSIVE_DEFAULT
  }
}

/**
 * Returns the renderer-safe security policy slice.
 *
 * `null` means "still loading on first call this session". Treat `null`
 * as the permissive default in render code:
 *
 * ```tsx
 * const policy = useSecurityPolicy()
 * const tunnelDisabled = policy?.tunnelSafe ?? false
 * if (tunnelDisabled) return null
 * ```
 */
export function useSecurityPolicy(): PublicSecurityPolicy | null {
  const [policy, setPolicy] = useState<PublicSecurityPolicy | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!cached) {
      cached = fetchPolicy()
    }
    cached.then((value) => {
      if (!cancelled) setPolicy(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return policy
}
