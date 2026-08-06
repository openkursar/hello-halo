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

/**
 * Tencent login — WeChat two-bubble mark. The `tencent` provider authenticates
 * via WeChat QR scan, so the WeChat glyph reads more clearly than a Tencent
 * wordmark. Single-color (`currentColor`) so it adapts to each call site's
 * color (tinted-on-light in the login selector, white-on-fill in settings).
 */
export const WeChatIcon: FC<BrandIconProps> = ({ size = 20, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={className}
    style={style}
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8.69 3.2C4.86 3.2 1.75 5.83 1.75 9.07c0 1.82.98 3.45 2.5 4.55.13.09.2.25.16.4l-.34 1.28c-.04.16.12.29.26.21l1.66-.96a.55.55 0 0 1 .44-.06c.66.19 1.36.29 2.09.3a4.5 4.5 0 0 1-.18-1.25c0-2.72 2.62-4.8 5.68-4.8.17 0 .34 0 .5.02-.5-2.9-3.44-5.56-7.83-5.56Zm-2.2 3.05a.98.98 0 1 1 0 1.96.98.98 0 0 1 0-1.96Zm4.42 0a.98.98 0 1 1 0 1.96.98.98 0 0 1 0-1.96Z" />
    <path d="M22.25 13.9c0-2.66-2.55-4.82-5.7-4.82s-5.7 2.16-5.7 4.82c0 2.67 2.55 4.83 5.7 4.83.66 0 1.29-.1 1.88-.28a.5.5 0 0 1 .4.05l1.36.78c.13.08.29-.05.25-.2l-.28-1.04a.4.4 0 0 1 .15-.43 4.6 4.6 0 0 0 1.94-3.71Zm-7.5-1.13a.82.82 0 1 1 0 1.64.82.82 0 0 1 0-1.64Zm3.6 0a.82.82 0 1 1 0 1.64.82.82 0 0 1 0-1.64Z" />
  </svg>
)

/** Brand icons keyed by AI-source provider type. */
const brandIcons: Record<string, FC<BrandIconProps>> = {
  'zhipu-coding-oauth': ZhipuIcon,
  'tencent': WeChatIcon
}

/** Returns a brand icon component for a provider type, or undefined if none. */
export function getBrandIcon(providerType: string): FC<BrandIconProps> | undefined {
  return brandIcons[providerType]
}
