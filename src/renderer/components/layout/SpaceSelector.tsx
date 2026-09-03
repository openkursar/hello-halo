/**
 * SpaceSelector - Header dropdown for switching between spaces
 *
 * Shows current space icon + name, click to open dropdown with all spaces.
 * Also the space *management* surface (create / rename / delete / reorder)
 * now that there's no HomePage to send that to — reorder was already here
 * (SortableSpaceList below); create/edit/delete were migrated in from it.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ChevronDown, Plus, Pencil, Trash2, Unplug, Search } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useSpaceStore } from '../../stores/space.store'
import { SpaceIcon } from '../icons/ToolIcons'
import { SortableSpaceList } from '../space/SortableSpaceList'
import { CreateSpaceDialog } from '../space/CreateSpaceDialog'
import { EditSpaceDialog } from '../space/EditSpaceDialog'
import { useTranslation } from '../../i18n'
import type { Space } from '../../types'

/** Minimum interval between loadSpaces calls (ms) */
const LOAD_THROTTLE_MS = 5_000

/** Max rows in the "Recent" preview section */
const RECENT_COUNT = 5
/** Below this many spaces, splitting into Recent/All just adds a redundant
 * section header over a list short enough to scan directly. */
const RECENT_SECTION_MIN_SPACES = RECENT_COUNT + 1

export function SpaceSelector() {
  const { t } = useTranslation()
  const { navigate } = useAppStore()
  const { haloSpace, spaces, currentSpace, setCurrentSpace, refreshCurrentSpace, loadSpaces, isLoading, reorderSpaces, deleteSpace } = useSpaceStore()
  const [isOpen, setIsOpen] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingSpace, setEditingSpace] = useState<Space | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
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

  // Clear the search query when the dropdown closes, so reopening starts fresh
  useEffect(() => {
    if (!isOpen) setSearchQuery('')
  }, [isOpen])

  const handleSelectSpace = (space: Space) => {
    if (space.isMissing) {
      setIsOpen(false)
      return
    }
    if (space.id === currentSpace?.id) {
      setIsOpen(false)
      return
    }
    setCurrentSpace(space)
    refreshCurrentSpace()  // Load full space data (preferences) from backend
    navigate('space')
    setIsOpen(false)
  }

  const handleCreateSpace = () => {
    setIsOpen(false)
    setShowCreateDialog(true)
  }

  const handleEditSpace = (e: React.MouseEvent, space: Space) => {
    e.stopPropagation()
    setEditingSpace(space)
  }

  // Same project-vs-centralized-space detection HomePage used, moved as-is.
  const handleDeleteSpace = async (e: React.MouseEvent, space: Space) => {
    e.stopPropagation()

    const lastSegment = space.path.split(/[/\\]/).pop() ?? ''
    const isCentralizedSpace = space.path.includes('/spaces/') && lastSegment.length === 36
    const isProjectSpace = !!space.workingDir || !isCentralizedSpace

    const message = isProjectSpace
      ? t('Are you sure you want to delete this space?\n\nOnly Halo data (conversation history) will be deleted, your project files will be kept.')
      : t('Are you sure you want to delete this space?\n\nAll conversations and files in the space will be deleted.')

    if (confirm(message)) {
      await deleteSpace(space.id)
    }
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

  // Search matches dedicated spaces by name; Halo Space stays pinned and
  // unfiltered regardless of query, same as it already is outside search.
  const trimmedQuery = searchQuery.trim().toLowerCase()
  const isSearching = trimmedQuery.length > 0
  const filteredSpaces = useMemo(
    () => isSearching ? spaces.filter(s => s.name.toLowerCase().includes(trimmedQuery)) : spaces,
    [spaces, isSearching, trimmedQuery]
  )

  // "Recent" is a read-only preview (deliberately not wired into
  // SortableSpaceList below — it duplicates entries already in "All
  // Spaces", so reordering it would be ambiguous about which copy moved).
  // Only shown once the list is long enough that a shortcut is worth it.
  const showRecentSection = !isSearching && spaces.length >= RECENT_SECTION_MIN_SPACES
  const recentSpaces = useMemo(() => {
    if (!showRecentSection) return []
    return [...spaces]
      .sort((a, b) => {
        const aTime = new Date(a.lastActiveAt || a.updatedAt).getTime()
        const bTime = new Date(b.lastActiveAt || b.updatedAt).getTime()
        return bTime - aTime
      })
      .slice(0, RECENT_COUNT)
  }, [spaces, showRecentSection])

  const displayName = currentSpace
    ? (currentSpace.isTemp ? t('Halo') : currentSpace.name)
    : t('Halo')

  const displayIcon = currentSpace?.icon || 'sparkles'

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2 py-1.5 text-sm hover:bg-secondary/80 rounded-lg transition-colors max-w-[140px] sm:max-w-[200px]"
        title={displayName}
      >
        <SpaceIcon iconId={displayIcon} size={18} className="flex-shrink-0" />
        <span className="font-medium truncate">{displayName}</span>
        <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-card border border-border rounded-xl shadow-lg z-50 py-1 max-h-[50vh] overflow-y-auto">
          {isLoading && allSpaces.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">{t('Loading...')}</div>
          )}

          {/* Search — only once there are enough spaces to be worth searching */}
          {spaces.length >= RECENT_SECTION_MIN_SPACES && (
            <div className="px-2 pb-1.5 sticky top-0 bg-card z-10">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('Search spaces')}
                  className="w-full pl-7 pr-2 py-1.5 text-xs bg-secondary/50 border border-border/50 rounded-lg outline-none focus:border-primary/50"
                />
              </div>
            </div>
          )}

          {/* Halo temp space — fixed at top, not draggable, never filtered by search */}
          {haloSpace && (
            <SpaceDropdownRow
              space={haloSpace}
              isActive={haloSpace.id === currentSpace?.id}
              onSelect={handleSelectSpace}
            />
          )}

          {isSearching ? (
            filteredSpaces.length > 0 ? (
              <div className="flex flex-col">
                {filteredSpaces.map(space => (
                  <SpaceDropdownRow
                    key={space.id}
                    space={space}
                    isActive={space.id === currentSpace?.id}
                    onSelect={handleSelectSpace}
                    onEdit={handleEditSpace}
                    onDelete={handleDeleteSpace}
                  />
                ))}
              </div>
            ) : (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">{t('No matching results found')}</div>
            )
          ) : (
            <>
              {/* Recent — read-only shortcut preview, duplicates entries also
                  listed in "All Spaces" below (not wired into the drag
                  reorder there, to keep "which copy moved" unambiguous) */}
              {showRecentSection && (
                <>
                  <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wide">
                    {t('Recent')}
                  </div>
                  {recentSpaces.map(space => (
                    <SpaceDropdownRow
                      key={space.id}
                      space={space}
                      isActive={space.id === currentSpace?.id}
                      onSelect={handleSelectSpace}
                      onEdit={handleEditSpace}
                      onDelete={handleDeleteSpace}
                    />
                  ))}
                  <div className="px-3 pt-2 pb-1 mt-1 border-t border-border/50 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wide">
                    {t('All spaces')}
                  </div>
                </>
              )}

              {/* Dedicated spaces — draggable to reorder */}
              {spaces.length > 0 && (
                <SortableSpaceList
                  items={spaces}
                  onReorder={(ids) => { void reorderSpaces(ids) }}
                  className="flex flex-col"
                  renderItem={(space) => (
                    <SpaceDropdownRow
                      space={space}
                      isActive={space.id === currentSpace?.id}
                      onSelect={handleSelectSpace}
                      onEdit={handleEditSpace}
                      onDelete={handleDeleteSpace}
                    />
                  )}
                />
              )}
            </>
          )}

          {/* New Space — replaces the old "Manage Spaces" link now that this
              dropdown is the space management surface itself. */}
          <div className="border-t border-border/50 mt-1 pt-1">
            <button
              onClick={handleCreateSpace}
              className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors flex items-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('New Space')}
            </button>
          </div>
        </div>
      )}

      {showCreateDialog && (
        <CreateSpaceDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={() => setShowCreateDialog(false)}
        />
      )}

      {editingSpace && (
        <EditSpaceDialog
          space={editingSpace}
          onClose={() => setEditingSpace(null)}
          onSaved={() => setEditingSpace(null)}
        />
      )}
    </div>
  )
}

/** A single space row inside the SpaceSelector dropdown. Halo Space (temp)
 * has no edit/delete — pass onEdit/onDelete only for real spaces. */
function SpaceDropdownRow({
  space,
  isActive,
  onSelect,
  onEdit,
  onDelete,
}: {
  space: Space
  isActive: boolean
  onSelect: (space: Space) => void
  onEdit?: (e: React.MouseEvent, space: Space) => void
  onDelete?: (e: React.MouseEvent, space: Space) => void
}) {
  const { t } = useTranslation()
  const name = space.isTemp ? t('Halo Space') : space.name
  const editable = !space.isTemp && !space.isMissing && (onEdit || onDelete)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(space)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(space)
        }
      }}
      className={`group w-full px-3 py-2.5 text-left text-sm transition-colors flex items-center gap-2.5 cursor-pointer ${
        space.isMissing
          ? 'text-muted-foreground cursor-not-allowed opacity-70'
          : `hover:bg-secondary/80 ${isActive ? 'text-primary bg-primary/5' : 'text-foreground'}`
      }`}
    >
      <SpaceIcon iconId={space.icon || (space.isTemp ? 'sparkles' : 'folder')} size={16} className="flex-shrink-0" />
      <span className="truncate flex-1 min-w-0">{name}</span>
      {space.isMissing && (
        <Unplug className="w-3.5 h-3.5 flex-shrink-0" aria-label={t('Unavailable')} />
      )}
      {(editable || (isActive && !space.isMissing)) && (
        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          {editable && (
            <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
              {onEdit && (
                <button
                  onClick={(e) => onEdit(e, space)}
                  className="p-1 hover:bg-secondary rounded transition-colors"
                  title={t('Edit Space')}
                >
                  <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              )}
              {onDelete && (
                <button
                  onClick={(e) => onDelete(e, space)}
                  className="p-1 hover:bg-destructive/20 rounded transition-colors"
                  title={t('Delete space')}
                >
                  <Trash2 className="w-3.5 h-3.5 text-destructive" />
                </button>
              )}
            </div>
          )}
          {isActive && !space.isMissing && (
            <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
          )}
        </div>
      )}
    </div>
  )
}
