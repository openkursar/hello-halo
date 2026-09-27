/**
 * KbAvatar — deterministic initial-based avatar for a knowledge base.
 *
 * Generates a colored circle with the first character of the KB name.
 * Color is derived from kb.id (or kb.name as fallback) for consistency
 * across renders without requiring a user choice.
 */

import { useMemo } from 'react'

interface KbAvatarProps {
  name: string
  id?: string
  size?: number
}

// A palette of accent colors that work on both light and dark backgrounds.
const AVATAR_COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-orange-500',
  'bg-teal-500',
  'bg-pink-500',
  'bg-indigo-500',
]

function hashSeed(s: string): number {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function KbAvatar({ name, id, size = 32 }: KbAvatarProps) {
  const initial = useMemo(() => {
    const trimmed = name.trim()
    return trimmed.length > 0 ? trimmed[0].toUpperCase() : '?'
  }, [name])

  const colorClass = useMemo(() => {
    const seed = id || name
    return AVATAR_COLORS[hashSeed(seed) % AVATAR_COLORS.length]
  }, [id, name])

  const fontSize = Math.max(size * 0.46, 10)

  return (
    <div
      className={`${colorClass} flex items-center justify-center rounded-full text-white font-semibold flex-shrink-0 select-none`}
      style={{ width: size, height: size, fontSize }}
      title={name}
      aria-hidden="true"
    >
      {initial}
    </div>
  )
}