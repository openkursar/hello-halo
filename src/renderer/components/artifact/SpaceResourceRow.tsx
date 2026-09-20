/**
 * SpaceResourceRow - read-only row shared by the Skill and MCP tabs
 *
 * Pure display: icon, name, optional description, and a scope badge
 * ("This workspace" / "Global") — both space- and global-scoped items are
 * listed side by side with a badge on each, so both variants are shown,
 * not just the global one.
 * No management actions live here (enable, disable, edit, uninstall) —
 * that's the digital-humans page's job. A row is only clickable when it
 * maps to something to jump to.
 *
 * `onUse` is an optional secondary action (reveal-on-hover "Use" button,
 * e.g. SkillsTab pre-filling the skill's slash command into the composer)
 * — separate from the row's own onClick so the row click stays consistent
 * with the file tree's click-to-preview convention (e.g. SkillsTab opening
 * a skill's SKILL.md in the canvas) without the two actions fighting over
 * the same click target.
 */

import { useTranslation } from '../../i18n'

interface SpaceResourceRowProps {
  icon: React.ReactNode
  /** When true, the icon renders bare (no tile background) — for icons that
   *  carry their own background, e.g. generated avatars. */
  bareIcon?: boolean
  name: string
  description?: string
  scope: 'global' | 'space'
  onClick?: () => void
  onUse?: () => void
  /** Label for the `onUse` pill. Defaults to "Use". */
  useLabel?: string
}

export function SpaceResourceRow({ icon, bareIcon, name, description, scope, onClick, onUse, useLabel }: SpaceResourceRowProps) {
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
      className={`group flex items-center gap-[9px] p-2 rounded-sm transition-colors ease-halo ${
        clickable ? 'cursor-pointer hover:bg-secondary' : ''
      }`}
    >
      {bareIcon ? (
        <span className="flex-shrink-0 w-[26px] h-[26px] flex items-center justify-center overflow-hidden rounded-[5px]">
          {icon}
        </span>
      ) : (
        <span className="flex-shrink-0 w-[26px] h-[26px] rounded-sm bg-secondary flex items-center justify-center text-[13px] text-muted-foreground">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground truncate">{name}</span>
        {description && (
          <span className="block text-[10px] text-subtle-foreground truncate">{description}</span>
        )}
      </span>
      {/* When a use action exists, it swaps in for the scope badge on hover
          instead of sitting alongside it — the two crowd each other in this
          narrow a row, and the badge (space vs global) is the less useful
          thing to see right when you're about to act on the row. */}
      {onUse && (
        <button
          onClick={(e) => { e.stopPropagation(); onUse() }}
          className="hidden group-hover:block flex-shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors ease-halo"
        >
          {useLabel ?? t('Use')}
        </button>
      )}
      {/* Prototype `.scope`: font-size 9px→10px(normalized), padding 1px 6px,
          pill, plain text — no icon, no bold. */}
      <span className={`self-center text-[10px] px-1.5 py-px rounded-full flex-shrink-0 ${
        onUse ? 'group-hover:hidden' : ''
      } ${
        isGlobal ? 'bg-halo-success/[0.14] text-halo-success' : 'bg-primary/[0.12] text-accent-on-dark'
      }`}>
        {isGlobal ? t('Global') : t('This workspace')}
      </span>
    </div>
  )
}
