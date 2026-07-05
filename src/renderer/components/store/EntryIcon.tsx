/**
 * EntryIcon
 *
 * Renders a store entry's `icon` field, which may be either an emoji glyph
 * or an image URL — URLs are rendered as <img> so the raw URL string never
 * appears as text.
 */

import { useState } from 'react'

// Keep in sync with the CSP img-src in index.html (plus http:, which is
// detected as an image but blocked at load — falling through to the text
// branch would render the raw URL).
const URL_ICON_PATTERN = /^(https?:|data:|halo-file:)/i

interface EntryIconProps {
  icon: string
  /** Tailwind text-size class applied when `icon` is an emoji glyph */
  textClassName?: string
  /** Pixel size (width/height) applied when `icon` is an image URL */
  imageSize?: number
}

export function EntryIcon({ icon, textClassName = 'text-base', imageSize = 20 }: EntryIconProps) {
  // Track the failed URL (not a boolean) so the state self-resets when a
  // reused component instance receives a different icon prop.
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const isImageUrl = URL_ICON_PATTERN.test(icon)

  if (isImageUrl && failedIcon !== icon) {
    return (
      <img
        src={icon}
        alt=""
        width={imageSize}
        height={imageSize}
        className="flex-shrink-0 rounded object-cover"
        style={{ width: imageSize, height: imageSize }}
        onError={() => setFailedIcon(icon)}
      />
    )
  }

  if (isImageUrl) {
    return null
  }

  return <span className={`flex-shrink-0 ${textClassName}`}>{icon}</span>
}
