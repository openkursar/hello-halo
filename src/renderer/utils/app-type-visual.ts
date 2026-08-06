/**
 * Visual metadata for an app type: the container shape/color mapping. Shared by
 * every surface that shows a typed icon (badge, icon container) so the mapping
 * lives in one place. Colors reference the type-color design tokens. The glyph
 * components themselves live in `app-type-glyph.tsx`.
 */

import type { AppType } from '../../shared/apps/spec-types'

/** Hexagon outline for the MCP "connector" icon (matches the store mock). */
export const APP_TYPE_HEXAGON_CLIP =
  'polygon(50% 0%, 93.3% 25%, 93.3% 75%, 50% 100%, 6.7% 75%, 6.7% 25%)'

export interface AppTypeIconShape {
  /** Container background / border / text-color + radius classes. */
  className: string
  /** True for the hexagon (MCP): the shape is produced by a clip-path on the
   * container (a clip-path shape cannot carry a CSS border). */
  hexagon: boolean
}

export function appTypeIconShape(type: AppType): AppTypeIconShape {
  switch (type) {
    case 'automation':
      return {
        className: 'rounded-full bg-primary/10 text-primary',
        hexagon: false,
      }
    case 'skill':
      return {
        className: 'rounded-[10px] bg-app-skill/10 text-app-skill',
        hexagon: false,
      }
    case 'mcp':
      return { className: 'bg-app-mcp/10 text-app-mcp', hexagon: true }
    default:
      return {
        className: 'rounded-[10px] bg-muted border border-border text-muted-foreground',
        hexagon: false,
      }
  }
}
