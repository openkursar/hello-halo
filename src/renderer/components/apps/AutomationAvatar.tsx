/**
 * AutomationAvatar
 *
 * Deterministic avatar for a digital human (automation app), generated from its
 * name with boring-avatars. Shared by the installed-app header and the store so
 * the same name always yields the same face.
 */

import Avatar from 'boring-avatars'

// Brand-aligned palette seeding the boring-avatars generator (algorithm input,
// not UI chrome — must be literal colors, cannot be theme tokens).
const AVATAR_COLORS = ['#84B9EF', '#6C8EBF', '#3D5A80', '#98C1D9', '#E0FBFC']

interface AutomationAvatarProps {
  /** Seed for the generated face. The same name always yields the same avatar. */
  name: string
  /** Rendered pixel size (square). */
  size: number
}

export function AutomationAvatar({ name, size }: AutomationAvatarProps) {
  return <Avatar size={size} name={name} variant="beam" colors={AVATAR_COLORS} />
}
