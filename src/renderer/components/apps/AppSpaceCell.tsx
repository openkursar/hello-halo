/**
 * AppSpaceCell
 *
 * The "Space" cell in an installed app's detail-page status grid. Clicking the
 * card navigates to that space; a hover-only swap icon in the corner opens a
 * dropdown that moves the app elsewhere without navigating.
 *
 * Shared by every app type, because what a space means differs per type
 * (working directory for a digital human, availability scope for a skill) but
 * the affordance doesn't — callers pass their own caption and menu title.
 */

import { useState, useRef, useEffect } from 'react'
import { Globe, ArrowLeftRight, Loader2, Check } from 'lucide-react'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { SpaceAvatar } from '../space/SpaceAvatar'
import { useTranslation } from '../../i18n'
import type { Space } from '../../types'

interface AppSpaceCellProps {
  /** null = global */
  spaceId: string | null
  /** Resolved space name, or the translated "Global" label */
  spaceLabel: string
  /** The space record, when space-scoped — drives the avatar */
  space?: Space
  /** One line under the value explaining what the space governs for this app type */
  caption: string
  /** Dropdown heading, e.g. "Move this skill to…" */
  menuTitle: string
  moving: boolean
  onMove: (newSpaceId: string | null) => Promise<void> | void
}

export function AppSpaceCell({ spaceId, spaceLabel, space, caption, menuTitle, moving, onMove }: AppSpaceCellProps) {
  const { t } = useTranslation()
  const spaces = useSpaceStore(s => s.spaces)
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const [menuOpen, setMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  const goToSpace = () => {
    if (spaceId === null) return
    const spaceStore = useSpaceStore.getState()
    const target = spaceStore.spaces.find(s => s.id === spaceId) ?? spaceStore.haloSpace
    if (target && target.id === spaceId) {
      spaceStore.setCurrentSpace(target)
      useAppStore.getState().navigate('space')
    }
  }

  const handlePick = async (newSpaceId: string | null) => {
    setMenuOpen(false)
    if (newSpaceId === spaceId || moving) return
    await onMove(newSpaceId)
  }

  const allSpaces = [
    ...(haloSpace ? [haloSpace] : []),
    ...spaces.filter(s => !haloSpace || s.id !== haloSpace.id),
  ]

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={goToSpace}
      onKeyDown={e => { if (e.key === 'Enter') goToSpace() }}
      className={`group relative text-left bg-card border border-border/60 rounded-lg px-3.5 py-3 transition-all
        ${spaceId === null ? 'cursor-default' : 'cursor-pointer hover:border-border hover:shadow-sm'}`}
    >
      <div className="text-[11px] text-subtle-foreground mb-[5px]">{t('Workspace')}</div>
      <div className="text-[13px] font-medium flex items-center gap-1.5">
        {spaceId === null && <Globe className="w-3.5 h-3.5 text-muted-foreground" />}
        {space && <SpaceAvatar space={space} size={16} />}
        <span className="truncate">{spaceLabel}</span>
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground">{caption}</div>

      {/* Hover swap icon — top-right corner */}
      <div ref={ref} className="absolute top-1.5 right-1.5">
        <button
          type="button"
          onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
          disabled={moving}
          title={t('Move to another workspace')}
          className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-all cursor-pointer"
          style={{ opacity: menuOpen || moving ? 1 : undefined }}
        >
          {moving ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowLeftRight className="w-3 h-3" />}
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] bg-popover border border-border rounded-lg shadow-lg py-1 text-[13px]">
            <div className="px-3 pt-1.5 pb-1 text-[11px] text-subtle-foreground">{menuTitle}</div>
            <button
              type="button"
              onClick={e => { e.stopPropagation(); void handlePick(null) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/60 transition-colors
                ${spaceId === null ? 'text-foreground font-medium' : 'text-muted-foreground'}`}
            >
              <Globe className="w-[18px] h-[18px] flex-shrink-0" />
              {t('Global (all workspaces)')}
              {spaceId === null && <Check className="w-3.5 h-3.5 ml-auto flex-shrink-0" />}
            </button>
            {allSpaces.length > 0 && <div className="my-1 border-t border-border/50" />}
            {allSpaces.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={e => { e.stopPropagation(); void handlePick(s.id) }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/60 transition-colors
                  ${spaceId === s.id ? 'text-foreground font-medium' : 'text-muted-foreground'}`}
              >
                <SpaceAvatar space={s} size={18} />
                <span className="truncate">{s.name}</span>
                {spaceId === s.id && <Check className="w-3.5 h-3.5 ml-auto flex-shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
