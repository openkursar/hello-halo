/**
 * Where an app may live.
 *
 * MCP servers and skills can be global (`spaceId === null`); a digital human
 * (automation) always belongs to a space because its working directory,
 * memory and conversations all resolve through one.
 */

import type { AppType } from './spec-types'

/** The built-in default (Halo) space; always exists, never persisted to disk. */
export const DEFAULT_SPACE_ID = 'halo-temp'

/**
 * The space an install lands in when the caller named none: a digital human
 * falls back to the Halo space, other app types stay global.
 */
export function resolveInstallSpaceId(spaceId: string | null | undefined, type: AppType): string | null {
  if (spaceId) return spaceId
  return type === 'automation' ? DEFAULT_SPACE_ID : null
}
