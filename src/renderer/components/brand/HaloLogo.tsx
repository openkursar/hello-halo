/**
 * HaloLogo - the brand mark, its face glancing and blinking (still under
 * reduced motion; the motion lives in the SVG itself).
 *
 * Usage:
 *   <HaloLogo size="sm" />      // 28px - for inline/small areas
 *   <HaloLogo size="md" />      // 48px - for medium contexts
 *   <HaloLogo size="lg" />      // 96px - for large displays (like splash)
 *   <HaloLogo size={64} />      // custom size in pixels
 */

import brandMarkAnimated from '../../assets/brand/halo-mark-animated.svg'

interface HaloLogoProps {
  /** Size preset or custom pixel value */
  size?: 'sm' | 'md' | 'lg' | number
  /** Optional additional class names */
  className?: string
}

// Size presets in pixels
const SIZE_PRESETS = {
  sm: 28,
  md: 48,
  lg: 96
} as const

export function HaloLogo({ size = 'md', className = '' }: HaloLogoProps) {
  const pixelSize = typeof size === 'number' ? size : SIZE_PRESETS[size]

  return (
    <img
      src={brandMarkAnimated}
      alt=""
      aria-hidden="true"
      className={`block shrink-0 ${className}`}
      style={{ width: pixelSize, height: pixelSize }}
    />
  )
}
