/**
 * SpaceResourceRow - read-only row shared by the Skill and MCP tabs
 *
 * Pure display: icon, name, optional description, and a "this space /
 * global" scope badge. No management actions live here (enable, disable,
 * edit, uninstall) — that's the digital-humans page's job. A row is only
 * clickable when it maps to something to jump to.
 */

import { Globe } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface SpaceResourceRowProps {
  icon: React.ReactNode
  name: string
  description?: string
  scope: 'global' | 'space'
  onClick?: () => void
}

export function SpaceResourceRow({ icon, name, description, scope, onClick }: SpaceResourceRowProps) {
  const { t } = useTranslation()
  const isGlobal = scope === 'global'
  const clickable = !!onClick

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.()
        }
      } : undefined}
      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border bg-secondary/40 ${
        clickable ? 'cursor-pointer hover:bg-secondary/80 transition-colors' : ''
      }`}
    >
      <span className="flex-shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground truncate">{name}</span>
        {description && (
          <span className="block text-xs text-muted-foreground truncate">{description}</span>
        )}
      </span>
      <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium border flex-shrink-0
        ${isGlobal
          ? 'bg-primary/10 text-primary border-primary/25'
          : 'bg-muted/60 text-muted-foreground border-border/40'}`}
      >
        {isGlobal && <Globe className="w-3 h-3" />}
        {isGlobal ? t('Global') : t('This space')}
      </span>
    </div>
  )
}
