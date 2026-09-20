/**
 * ScopeSelector
 *
 * Interactive scope badge for Skill and MCP detail pages: shows whether the
 * app is global or scoped to one space, and opens a dropdown to move it
 * without uninstalling/reinstalling. Extracted from SkillInfoCard, which had
 * the only implementation — MCP had no scope display or move-scope entry at
 * all. Both surfaces now share this component.
 */

import { useState, useRef, useEffect } from 'react'
import { Globe, ChevronDown, Check, Loader2 } from 'lucide-react'
import { useSpaceStore } from '../../stores/space.store'
import { SpaceAvatar } from '../space/SpaceAvatar'
import { useTranslation } from '../../i18n'

interface ScopeSelectorProps {
  /** Current scope: null = global, otherwise a space id */
  spaceId: string | null
  /** Resolved display name for a space-scoped app (ignored when global) */
  spaceName?: string
  /** Called with the newly chosen scope; no-op if unchanged */
  onMove: (newSpaceId: string | null) => Promise<void> | void
}

export function ScopeSelector({ spaceId, spaceName, onMove }: ScopeSelectorProps) {
  const { t } = useTranslation()
  const spaces = useSpaceStore(s => s.spaces)
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const [open, setOpen] = useState(false)
  const [moving, setMoving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const isGlobal = spaceId === null
  const allSpaces = [
    ...(haloSpace ? [haloSpace] : []),
    ...spaces.filter(s => !haloSpace || s.id !== haloSpace.id),
  ]
  const currentSpace = allSpaces.find(s => s.id === spaceId)

  const handlePick = async (newSpaceId: string | null) => {
    setOpen(false)
    if (newSpaceId === spaceId || moving) return
    setMoving(true)
    try {
      await onMove(newSpaceId)
    } finally {
      setMoving(false)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={moving}
        onClick={() => setOpen(v => !v)}
        title={t('Click to change workspace')}
        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium border
          transition-colors cursor-pointer select-none disabled:opacity-60 disabled:cursor-not-allowed
          ${isGlobal
            ? 'bg-primary/10 text-primary border-primary/25 hover:bg-primary/20'
            : 'bg-muted/60 text-muted-foreground border-border/40 hover:bg-muted'
          }`}
      >
        {moving ? (
          <Loader2 className="w-3 h-3 flex-shrink-0 animate-spin" />
        ) : isGlobal ? (
          <Globe className="w-3 h-3 flex-shrink-0" />
        ) : (
          currentSpace && <SpaceAvatar space={currentSpace} size={12} />
        )}
        <span>{isGlobal ? t('Global') : (spaceName ?? spaceId)}</span>
        {!moving && <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-60" />}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[220px] bg-popover border border-border rounded-lg shadow-lg py-1 text-[13px]">
          <button
            type="button"
            onClick={() => handlePick(null)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/60 transition-colors
              ${spaceId === null ? 'text-foreground font-medium' : 'text-muted-foreground'}`}
          >
            <Globe className="w-[18px] h-[18px] flex-shrink-0" />
            {t('Global (all workspaces)')}
            {spaceId === null && <Check className="w-3.5 h-3.5 ml-auto flex-shrink-0" />}
          </button>

          {allSpaces.length > 0 && <div className="my-1 border-t border-border/50" />}

          {allSpaces.map(space => (
            <button
              key={space.id}
              type="button"
              onClick={() => handlePick(space.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/60 transition-colors
                ${spaceId === space.id ? 'text-foreground font-medium' : 'text-muted-foreground'}`}
            >
              <SpaceAvatar space={space} size={18} />
              <span className="truncate">{space.name}</span>
              {spaceId === space.id && <Check className="w-3.5 h-3.5 ml-auto flex-shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
