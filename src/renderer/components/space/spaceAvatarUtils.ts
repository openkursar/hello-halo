/**
 * Solid-color + letter identity for a space, used wherever SpaceSelector
 * shows a compact space avatar (header trigger, dropdown rows) and wherever
 * Create/EditSpaceDialog let the user pick a color.
 *
 * The palette is a small set of existing theme tokens (never raw hex, so it
 * follows the active theme automatically) exposed under short, storable ids
 * — `space.color` persists one of SPACE_COLOR_IDS, not a CSS value, so it
 * stays theme-portable across light/dark and any future palette tweak.
 */
import type { Space } from '../../types'

// Order and count match the prototype's `#wsSwatch` exactly (6 swatches:
// indigo, sky, violet, green, amber, red) — each mapped to the nearest
// existing theme token by hue instead of copying the prototype's raw hex.
export const SPACE_COLOR_IDS = ['primary', 'skill', 'violet', 'success', 'mcp', 'danger'] as const
export type SpaceColorId = typeof SPACE_COLOR_IDS[number]

export const SPACE_COLOR_CSS: Record<SpaceColorId, string> = {
  primary: 'hsl(var(--primary))',      // prototype #6366f1 indigo
  skill: 'hsl(var(--app-skill))',      // prototype #0ea5e9 sky
  violet: 'hsl(var(--hero-to))',       // prototype #8b5cf6 violet
  success: 'hsl(var(--halo-success))', // prototype #22c55e green
  mcp: 'hsl(var(--app-mcp))',          // prototype #f59e0b amber
  danger: 'hsl(var(--destructive))',   // prototype #ef4444 red
}

function isSpaceColorId(value: string): value is SpaceColorId {
  return (SPACE_COLOR_IDS as readonly string[]).includes(value)
}

function hashToIndex(id: string, length: number): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return Math.abs(hash) % length
}

export function spaceAvatarLetter(space: Pick<Space, 'name' | 'isTemp'>): string {
  if (space.isTemp) return 'H'
  const trimmed = space.name.trim()
  return trimmed ? trimmed[0].toUpperCase() : '?'
}

export function spaceAvatarColor(space: Pick<Space, 'id' | 'isTemp' | 'color'>): string {
  // The pinned Halo Space is a single fixed singleton, not user-colorable —
  // it always gets the brand color (primary blue).
  if (space.isTemp) return SPACE_COLOR_CSS.primary
  if (space.color && isSpaceColorId(space.color)) return SPACE_COLOR_CSS[space.color]
  // No color chosen (space predates this field) — derive a stable one from
  // the id so the same space always renders the same color.
  return SPACE_COLOR_CSS[SPACE_COLOR_IDS[hashToIndex(space.id, SPACE_COLOR_IDS.length)]]
}
