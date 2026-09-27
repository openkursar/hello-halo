/**
 * Solid-color letter avatar for a space — used by both the SpaceSelector
 * header trigger and its dropdown rows so the two stay visually consistent.
 */
import { spaceAvatarColor, spaceAvatarLetter } from './spaceAvatarUtils'
import type { Space } from '../../types'

export function SpaceAvatar({
  space,
  size,
  className = '',
}: {
  space: Pick<Space, 'id' | 'name' | 'isTemp' | 'color'>
  size: number
  className?: string
}) {
  return (
    <span
      className={`flex items-center justify-center text-white font-bold flex-shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        background: spaceAvatarColor(space),
        // Scales with the box instead of `rounded-sm`: that resolves to a fixed
        // 8px from --radius, which reads as a rounded square at 24px but
        // collapses into a circle at any size under ~16px.
        borderRadius: Math.round(size / 3),
        fontSize: Math.round(size * 0.46),
      }}
    >
      {spaceAvatarLetter(space)}
    </span>
  )
}
