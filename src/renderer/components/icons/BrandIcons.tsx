/**
 * Brand icons for AI-source providers.
 *
 * Halo renders provider icons from a small lucide set (see the `iconMap`s in the
 * settings/setup components). Providers with a recognizable brand mark register
 * an SVG here, keyed by provider type. These components accept the same props
 * used at the lucide call sites (size/className/style), so they are drop-in
 * replacements. Providers without a brand icon fall back to the lucide path.
 */
import type { CSSProperties, FC } from 'react'

export interface BrandIconProps {
  size?: number
  className?: string
  style?: CSSProperties
}

/** Zhipu AI (BigModel / GLM) — stylized "Z" mark. */
export const ZhipuIcon: FC<BrandIconProps> = ({ size = 20, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={className}
    style={style}
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M4 3h16v3.2L9.4 17.8H20V21H4v-3.2L14.6 6.2H4V3z" />
  </svg>
)

/** Brand icons keyed by AI-source provider type. */
const brandIcons: Record<string, FC<BrandIconProps>> = {
  'zhipu-coding-oauth': ZhipuIcon
}

/** Returns a brand icon component for a provider type, or undefined if none. */
export function getBrandIcon(providerType: string): FC<BrandIconProps> | undefined {
  return brandIcons[providerType]
}
