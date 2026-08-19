/**
 * AppTypeIcon
 *
 * Shaped, type-colored icon container for a store app (agent = circle,
 * skill = rounded square, mcp = hexagon, others = rounded square). Shows the
 * entry's own icon glyph when present, otherwise a type fallback icon.
 */

import { useState } from 'react'
import type { AppType } from '../../../shared/apps/spec-types'
import { appTypeIconShape, APP_TYPE_HEXAGON_CLIP } from '../../utils/app-type-visual'
import { APP_TYPE_GLYPH } from './app-type-glyph'
import { AutomationAvatar } from '../apps/AutomationAvatar'

type AppTypeIconSize = 'xs' | 'sm' | 'md' | 'lg'

const SIZE_CLASSES: Record<AppTypeIconSize, { box: string; glyph: string; icon: string; img: string }> = {
  xs: { box: 'w-[26px] h-[26px]', glyph: 'text-sm', icon: 'w-3.5 h-3.5', img: 'w-[18px] h-[18px]' },
  sm: { box: 'w-[34px] h-[34px]', glyph: 'text-base', icon: 'w-4 h-4', img: 'w-6 h-6' },
  md: { box: 'w-[42px] h-[42px]', glyph: 'text-lg', icon: 'w-[18px] h-[18px]', img: 'w-7 h-7' },
  lg: { box: 'w-14 h-14', glyph: 'text-2xl', icon: 'w-6 h-6', img: 'w-9 h-9' },
}

/** Pixel size of the generated automation avatar, matching each box above. */
const AVATAR_PX: Record<AppTypeIconSize, number> = { xs: 26, sm: 34, md: 42, lg: 56 }

/** entry.icon may be an emoji/text glyph or an image URL (per the spec). */
function isImageIcon(value: string): boolean {
  return /^(https?:\/\/|data:image\/)/i.test(value.trim())
}

/**
 * Render an icon string as a glyph only when it is an actual emoji. Plain words
 * (e.g. an icon-name keyword like "social") are not displayable glyphs and fall
 * back to the type icon instead of showing raw text.
 */
function isEmojiIcon(value: string): boolean {
  return /\p{Extended_Pictographic}/u.test(value)
}

interface AppTypeIconProps {
  type: AppType
  /** The entry's own icon glyph (emoji/text). Falls back to a type icon. */
  icon?: string
  /** Seed for the generated automation avatar when no custom icon is present. */
  name?: string
  size?: AppTypeIconSize
}

export function AppTypeIcon({ type, icon, name, size = 'md' }: AppTypeIconProps) {
  const { className, hexagon } = appTypeIconShape(type)
  const s = SIZE_CLASSES[size]
  const Fallback = APP_TYPE_GLYPH[type]
  const [imageBroken, setImageBroken] = useState(false)

  const hasImage = !!icon && isImageIcon(icon) && !imageBroken
  const hasEmoji = !!icon && !isImageIcon(icon) && isEmojiIcon(icon)

  // Digital human (automation) without a custom icon: show a deterministic
  // boring-avatars face seeded by name, matching the installed-app header,
  // instead of the generic robot glyph.
  if (type === 'automation' && !hasImage && !hasEmoji) {
    return (
      <span className={`flex items-center justify-center flex-shrink-0 overflow-hidden rounded-full ${s.box}`}>
        <AutomationAvatar name={name || 'digital-human'} size={AVATAR_PX[size]} />
      </span>
    )
  }

  const glyph = hasImage ? (
    <img
      src={icon}
      alt=""
      className={`relative z-10 object-contain ${s.img}`}
      onError={() => setImageBroken(true)}
    />
  ) : hasEmoji ? (
    <span className={`relative z-10 leading-none ${s.glyph}`}>{icon}</span>
  ) : (
    <Fallback className={`relative z-10 ${s.icon}`} />
  )

  return (
    <span
      className={`relative flex items-center justify-center flex-shrink-0 ${s.box} ${className}`}
      style={hexagon ? { clipPath: APP_TYPE_HEXAGON_CLIP } : undefined}
    >
      {glyph}
    </span>
  )
}
