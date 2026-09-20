/**
 * SpaceSelector - Header control for switching between spaces
 *
 * Two separate controls, not one button: a "Workspace" label that links to
 * the workspace management page (SpacesPage — rename/delete/reorder/asset
 * overview all live there now), and the dropdown trigger next to it for
 * switching. Splitting them matters for a11y — two different actions must
 * not share one click target — see the workspace-management requirements
 * the dropdown/page split of duties.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ChevronDown, ChevronRight, Plus, Unplug, Search, Lightbulb, LayoutGrid } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useSpaceStore } from '../../stores/space.store'
import { SpaceAvatar } from '../space/SpaceAvatar'
import { SpaceSummaryLine } from '../space/SpaceAssetChips'
import { CreateSpaceDialog } from '../space/CreateSpaceDialog'
import { useTranslation } from '../../i18n'
import type { Space, SpaceSummary } from '../../types'

/** Minimum interval between loadSpaces calls (ms) */
const LOAD_THROTTLE_MS = 5_000

/** Max rows in the "Recent" preview section */
const RECENT_COUNT = 3
/** Below this many spaces, splitting into Recent/All just adds a redundant
 * section header over a list short enough to scan directly. */
const RECENT_SECTION_MIN_SPACES = RECENT_COUNT + 1

export function SpaceSelector() {
  const { t } = useTranslation()
  const { navigate } = useAppStore()
  const { haloSpace, spaces, currentSpace, summaries, setCurrentSpace, refreshCurrentSpace, loadSpaces, loadSpaceSummaries, isLoading } = useSpaceStore()
  const [isOpen, setIsOpen] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
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

  // Refresh spaces when dropdown opens (throttled). Summaries feed the rows'
  // asset chips and carry their own TTL in the store.
  useEffect(() => {
    if (isOpen) {
      throttledLoadSpaces()
      void loadSpaceSummaries()
    }
  }, [isOpen, throttledLoadSpaces, loadSpaceSummaries])

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

  // External open trigger — the command palette's "Switch Space" quick
  // action can't reach this component's local isOpen state directly (it
  // lives on a different page/tree entirely), so it asks via this event
  // instead, same pattern as ChatView's 'search:navigate-to-message'.
  useEffect(() => {
    const handleOpenRequest = () => setIsOpen(true)
    window.addEventListener('space-selector:open', handleOpenRequest)
    return () => window.removeEventListener('space-selector:open', handleOpenRequest)
  }, [])

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

  const handleSpaceCreated = (space: Space) => {
    setShowCreateDialog(false)
    setCurrentSpace(space)
    refreshCurrentSpace()
    navigate('space')
  }

  const handleCreateSpace = () => {
    setIsOpen(false)
    setShowCreateDialog(true)
  }

  const handleGoToWorkspaces = () => {
    setIsOpen(false)
    navigate('spaces')
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

  // "Recent" is a read-only preview — it duplicates entries also listed in
  // "All Spaces" below. Only shown once the list is long enough that a
  // shortcut is worth it.
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

  // Matches what the dropdown row calls the same space. "Halo" alone read as
  // the app's own name to a first-time user, hiding that this is a space at all.
  const displayName = currentSpace
    ? (currentSpace.isTemp ? t('Halo Workspace') : currentSpace.name)
    : t('Halo Workspace')

  return (
    <div className="flex items-center">
      {/* Separate control from the dropdown trigger below — this one
          navigates, it doesn't open anything. Two different actions can't
          share one click target. The leading icon is the only thing marking
          it as a destination at rest: plain header text reads as a label,
          and users were not finding the management page behind it. Dropped
          under `sm`, where the header has no room and the name alone has to
          carry the "this is a workspace" signal (SpaceAvatar + displayName
          in the trigger). */}
      <button
        onClick={handleGoToWorkspaces}
        className="hidden sm:flex items-center gap-1.5 h-9 pl-2 pr-2.5 flex-shrink-0 rounded-sm text-sm text-muted-foreground hover:bg-secondary hover:text-foreground hover:underline underline-offset-[3px] transition-colors ease-halo"
        title={t('Manage workspaces')}
      >
        <LayoutGrid className="w-3.5 h-3.5 flex-shrink-0" />
        {t('Workspace')}
      </button>
      <ChevronRight aria-hidden="true" className="hidden sm:block w-3.5 h-3.5 flex-shrink-0 text-subtle-foreground opacity-60 -mx-[3px]" />

      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="h-9 pl-1.5 pr-2 flex items-center gap-[9px] border border-transparent rounded-sm text-sm hover:bg-secondary hover:border-primary/[0.18] transition-colors ease-halo max-w-[140px] sm:max-w-[180px]"
          title={t('Current workspace: {{name}} — click to switch', { name: displayName })}
        >
          <SpaceAvatar space={currentSpace ?? { id: 'halo', name: displayName, isTemp: true }} size={24} />
          <span className="font-semibold tracking-[-0.01em] truncate">{displayName}</span>
          <ChevronDown className="w-3 h-3 flex-shrink-0 text-subtle-foreground" />
        </button>

        {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-[288px] bg-card border border-border rounded-xl shadow-pop z-50 max-h-[50vh] flex flex-col overflow-hidden">
          {/* Search — border-b separates it from the scrollable list below,
              matching the prototype's `.sp-search{border-bottom:1px solid
              var(--border)}`. flex-shrink-0 keeps it out of the scroll area
              entirely (no more `sticky`, which only fakes staying in place
              while still eating into the scrollable region's height). */}
          {spaces.length >= RECENT_SECTION_MIN_SPACES && (
            <div className="flex-shrink-0 px-3 py-2.5 border-b border-border">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle-foreground pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('Search workspaces')}
                  className="w-full h-8 pl-7 pr-2.5 text-xs bg-secondary border border-border rounded-sm outline-none focus:border-primary transition-colors ease-halo"
                />
              </div>
            </div>
          )}

          {/* Scrollable list region — only this area scrolls; search box
              above and tip/New Space below stay fixed regardless of list length. */}
          <div className="flex-1 min-h-0 overflow-y-auto py-1">
            {isLoading && allSpaces.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">{t('Loading...')}</div>
            )}

            {/* Prototype's `.sp-sec{padding:8px 6px 4px}` wraps the label+rows
                group with a 6px horizontal inset — the rows' own 10px padding
                (below) compounds to the prototype's 16px total, and the
                hover/selected pill ends up floating with a margin from the
                popover edge instead of running flush to it. */}
            <div className="px-1.5">
              {/* Halo temp space — fixed at top, not draggable, never filtered by search */}
              {haloSpace && (
                <SpaceDropdownRow
                  space={haloSpace}
                  summary={summaries[haloSpace.id]}
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
                        summary={summaries[space.id]}
                        isActive={space.id === currentSpace?.id}
                        onSelect={handleSelectSpace}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="px-1.5 py-4 text-xs text-muted-foreground text-center">{t('No matching results found')}</div>
                )
              ) : (
                <>
                  {/* Recent — read-only shortcut preview, duplicates entries also
                      listed in "All Spaces" below. */}
                  {showRecentSection && (
                    <>
                      <div className="px-2.5 pt-0.5 pb-1 text-[10px] font-semibold text-subtle-foreground uppercase tracking-[0.06em]">
                        {t('Recent')}
                      </div>
                      {recentSpaces.map(space => (
                        <SpaceDropdownRow
                          key={space.id}
                          space={space}
                          summary={summaries[space.id]}
                          isActive={space.id === currentSpace?.id}
                          onSelect={handleSelectSpace}
                        />
                      ))}
                      <div className="px-2.5 pt-0.5 pb-1 mt-1 border-t border-border/50 text-[10px] font-semibold text-subtle-foreground uppercase tracking-[0.06em]">
                        {t('All workspaces')}
                      </div>
                    </>
                  )}

                  {/* Dedicated spaces — switch only. Reorder/rename/delete
                      moved to the workspace management page (SpacesPage). */}
                  {spaces.map(space => (
                    <SpaceDropdownRow
                      key={space.id}
                      space={space}
                      summary={summaries[space.id]}
                      isActive={space.id === currentSpace?.id}
                      onSelect={handleSelectSpace}
                    />
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Tip + New Space — fixed footer chrome, outside the scroll area,
              so the create action stays reachable without scrolling no
              matter how many spaces are in the list. */}
          <div className="flex-shrink-0 border-t border-border px-3 py-2.5 flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground bg-muted/30">
            <Lightbulb className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-subtle-foreground" strokeWidth={1.8} />
            <span>
              <b className="text-foreground">{t('A workspace')}</b>
              {' '}
              {t('is an isolated context for one project: its folder, conversations, knowledge base, digital humans, and installed skills. Create one per project, client, or goal to keep things separate and reusable.')}
            </span>
          </div>

          {/* New Space — Prototype's `.sp-foot{padding:6px;border-top:1px
              solid var(--border)}`. The management link repeats the header
              breadcrumb's destination: this is where someone already looking
              for "where do I rename/delete a workspace" ends up. */}
          <div className="flex-shrink-0 border-t border-border px-1.5 py-1">
            <button
              onClick={handleCreateSpace}
              className="w-full rounded-sm px-2.5 py-2 text-left text-[13px] text-accent-on-dark hover:bg-primary/[0.12] transition-colors ease-halo flex items-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('New Workspace')}
            </button>
            <div className="my-1 border-t border-border/60" />
            <button
              onClick={handleGoToWorkspaces}
              className="w-full rounded-sm px-2.5 py-2 text-left text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors ease-halo flex items-center gap-2"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              {t('Manage workspaces')}
            </button>
          </div>
        </div>
        )}
      </div>

      {showCreateDialog && (
        <CreateSpaceDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={handleSpaceCreated}
        />
      )}
    </div>
  )
}

/** A single space row inside the SpaceSelector dropdown — switch only, see
 * the workspace management page (SpacesPage) for rename/delete/reorder.
 *
 * The second line is a summary (conversations + asset counts), not the path:
 * what distinguishes one workspace from another when picking is what it
 * holds, and a path is too long to read at 288px anyway (it stays on the
 * row's tooltip). */
function SpaceDropdownRow({
  space,
  summary,
  isActive,
  onSelect,
}: {
  space: Space
  summary?: SpaceSummary
  isActive: boolean
  onSelect: (space: Space) => void
}) {
  const { t } = useTranslation()
  const name = space.isTemp ? t('Halo Workspace') : space.name

  return (
    <div
      role="button"
      tabIndex={0}
      title={space.isTemp ? undefined : (space.workingDir || space.path)}
      onClick={() => onSelect(space)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(space)
        }
      }}
      className={`group w-full rounded-sm px-2.5 py-[7px] text-left transition-colors ease-halo flex items-center gap-[9px] cursor-pointer ${
        space.isMissing
          ? 'text-muted-foreground cursor-not-allowed opacity-70'
          : `hover:bg-secondary text-foreground ${isActive ? 'bg-primary/[0.12]' : ''}`
      }`}
    >
      <SpaceAvatar space={space} size={24} className={space.isMissing ? 'opacity-60' : ''} />
      <div className="flex-1 min-w-0">
        <span className="block truncate text-[13px] font-medium">{name}</span>
        {!space.isMissing && (
          <div className="mt-0.5">
            <SpaceSummaryLine summary={summary} />
          </div>
        )}
      </div>
      {space.isMissing && (
        <Unplug className="w-3.5 h-3.5 flex-shrink-0" aria-label={t('Unavailable')} />
      )}
    </div>
  )
}
