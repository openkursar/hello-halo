/**
 * The color block an auth provider is shown in — used by every provider list so
 * one entry cannot look like two different logins across onboarding and
 * settings.
 *
 * product.json supplies a solid brand hex; the tile tints it as the background
 * and keeps the glyph in the full color. A solid fill with a white glyph would
 * disappear whenever a distribution configures a light `iconBgColor`.
 */
import { getProviderIcon } from './BrandIcons'
import type { AuthProviderConfig } from '../../../shared/types'

const TILE_SIZE = {
  sm: 'w-9 h-9',
  md: 'w-10 h-10'
} as const

interface ProviderIconTileProps {
  provider: AuthProviderConfig
  size?: keyof typeof TILE_SIZE
}

function hexToRgba(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return `rgba(128, 128, 128, ${alpha})`
  return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`
}

export function ProviderIconTile({ provider, size = 'sm' }: ProviderIconTileProps) {
  const Icon = getProviderIcon(provider.type, provider.icon)
  return (
    <div
      className={`${TILE_SIZE[size]} rounded-lg flex items-center justify-center shrink-0`}
      style={{ backgroundColor: hexToRgba(provider.iconBgColor, 0.15) }}
    >
      <Icon size={20} style={{ color: provider.iconBgColor }} />
    </div>
  )
}
