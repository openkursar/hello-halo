/**
 * SpaceSelector - Header dropdown for switching between spaces
 *
 * Shows current space icon + name, click to open dropdown with all spaces.
 * Bottom link navigates to HomePage for space management.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown, Settings2 } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useSpaceStore } from '../../stores/space.store'
import { SpaceIcon } from '../icons/ToolIcons'
import { useTranslation } from '../../i18n'
import type { Space } from '../../types'

/** Minimum interval between loadSpaces calls (ms) */
const LOAD_THROTTLE_MS = 5_000

export function SpaceSelector() {
  const { t } = useTranslation()
  const { setView } = useAppStore()
  const { haloSpace, spaces, currentSpace, setCurrentSpace, refreshCurrentSpace, loadSpaces, isLoading } = useSpaceStore()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const lastLoadRef = useRef(0)

  // Throttled loadSpaces — skips if called within LOAD_THROTTLE_MS of last call
  const throttledLoadSpaces = useCallback(() => {
    const now = Date.now()
    if (now - lastLoadRef.current < LOAD_THROTTLE_MS) return
    lastLoadRef.current = now
    loadSpaces()
  }, [loadSpaces])

  // Eagerly load spaces on mount so dropdown is ready
  useEffect(() => {
    throttledLoadSpaces()
  }, [throttledLoadSpaces])

  // Refresh spaces when dropdown opens (throttled)
  useEffect(() => {
    if (isOpen) {
      throttledLoadSpaces()
    }
  }, [isOpen, throttledLoadSpaces])

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('click', handleClickOutside)
    }
  }, [isOpen])

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  const handleSelectSpace = (space: Space) => {
    if (space.id === currentSpace?.id) {
      setIsOpen(false)
      return
    }
    setCurrentSpace(space)
    refreshCurrentSpace()  // Load full space data (preferences) from backend
    setView('space')
    setIsOpen(false)
  }

  const handleManageSpaces = () => {
    setIsOpen(false)
    setView('home')
  }

  // Build space list: Halo Space first, then dedicated spaces
  // Fallback: if store hasn't loaded yet, at least show currentSpace
  const storeSpaces: Space[] = [
    ...(haloSpace ? [haloSpace] : []),
    ...spaces
  ]
  const allSpaces: Space[] = storeSpaces.length > 0
    ? storeSpaces
    : (currentSpace ? [currentSpace] : [])

  const displayName = currentSpace
    ? (currentSpace.isTemp ? t('Halo') : currentSpace.name)
    : t('Halo')

  const displayIcon = currentSpace?.icon || 'sparkles'

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2 py-1.5 text-sm hover:bg-secondary/80 rounded-lg transition-colors max-w-[200px]"
        title={displayName}
      >
        <SpaceIcon iconId={displayIcon} size={18} className="flex-shrink-0" />
        <span className="font-medium truncate hidden sm:inline">{displayName}</span>
        <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-card border border-border rounded-xl shadow-lg z-50 py-1 max-h-[50vh] overflow-y-auto">
          {isLoading && allSpaces.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">{t('Loading...')}</div>
          )}
          {allSpaces.map(space => {
            const isActive = space.id === currentSpace?.id
            const name = space.isTemp ? t('Halo Space') : space.name

            return (
              <button
                key={space.id}
                onClick={() => handleSelectSpace(space)}
                className={`w-full px-3 py-2.5 text-left text-sm hover:bg-secondary/80 transition-colors flex items-center gap-2.5 ${
                  isActive ? 'text-primary bg-primary/5' : 'text-foreground'
                }`}
              >
                <SpaceIcon iconId={space.icon || (space.isTemp ? 'sparkles' : 'folder')} size={16} className="flex-shrink-0" />
                <span className="truncate">{name}</span>
                {isActive && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                )}
              </button>
            )
          })}

          {/* Manage Spaces link */}
          <div className="border-t border-border/50 mt-1 pt-1">
            <button
              onClick={handleManageSpaces}
              className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors flex items-center gap-2"
            >
              <Settings2 className="w-3.5 h-3.5" />
              {t('Manage Spaces')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
