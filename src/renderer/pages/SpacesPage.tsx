/**
 * Spaces Page - Workspace management
 *
 * The workspace management surface the SpaceSelector dropdown's own doc
 * comment used to apologize for not having: rename/delete/reorder, an
 * asset overview per workspace (files/digital humans/skills/MCP — see
 * SpaceCard), and a recovery path for a disconnected workspace. The
 * dropdown itself stays a pure switcher (see SpaceSelector.tsx).
 *
 * Not a two-level "cards → detail page" surface like Apps/Tlon: a
 * workspace's "detail" already exists — it's the space page itself
 * (conversation + canvas + resource rail). Opening a card just switches
 * there; management actions live on the card's own `⋯` menu instead of a
 * dedicated detail screen.
 */

import { useState, useEffect, useCallback } from 'react'
import { Search, RefreshCw, Plus } from 'lucide-react'
import { Header } from '../components/layout/Header'
import { SpaceCard } from '../components/space/SpaceCard'
import { NewSpaceCard } from '../components/space/NewSpaceCard'
import { CreateSpaceDialog } from '../components/space/CreateSpaceDialog'
import { SortableSpaceList } from '../components/space/SortableSpaceList'
import { useSpaceStore } from '../stores/space.store'
import { useAppStore } from '../stores/app.store'
import { useTranslation } from '../i18n'
import type { Space, ArtifactRailTab } from '../types'

const GRID_CLASSES = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5'

export function SpacesPage() {
  const { t } = useTranslation()
  const { navigate } = useAppStore()
  const {
    haloSpace,
    spaces,
    currentSpace,
    summaries,
    summariesLoading,
    loadSpaces,
    loadSpaceSummaries,
    setCurrentSpace,
    refreshCurrentSpace,
    reorderSpaces,
    setPendingArtifactRailTab,
  } = useSpaceStore()

  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  useEffect(() => {
    loadSpaces()
    loadSpaceSummaries()
    // Load once on entry — the header's refresh button covers staying current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRefresh = useCallback(() => {
    loadSpaces()
    loadSpaceSummaries(true)
  }, [loadSpaces, loadSpaceSummaries])

  // Card / asset-chip click: switch to the workspace, optionally requesting
  // a resource-rail tab, then enter it. Disconnected workspaces can only be
  // managed from their own `⋯` menu (SpaceCard) — not opened.
  const openSpace = useCallback((space: Space, tab?: ArtifactRailTab) => {
    if (space.isMissing) return
    if (space.id !== currentSpace?.id) {
      setCurrentSpace(space)
      void refreshCurrentSpace()
    }
    if (tab) setPendingArtifactRailTab(tab)
    navigate('space')
  }, [currentSpace, setCurrentSpace, refreshCurrentSpace, setPendingArtifactRailTab, navigate])

  const handleSpaceCreated = (space: Space) => {
    setShowCreateDialog(false)
    setCurrentSpace(space)
    void refreshCurrentSpace()
    navigate('space')
  }

  const trimmedQuery = searchQuery.trim().toLowerCase()
  const isSearching = trimmedQuery.length > 0

  const availableSpaces = spaces.filter(s => !s.isMissing)
  const missingSpaces = spaces.filter(s => s.isMissing)
  const filteredAvailable = isSearching
    ? availableSpaces.filter(s => s.name.toLowerCase().includes(trimmedQuery))
    : availableSpaces
  const filteredMissing = isSearching
    ? missingSpaces.filter(s => s.name.toLowerCase().includes(trimmedQuery))
    : missingSpaces

  const renderCard = (space: Space) => (
    <SpaceCard
      key={space.id}
      space={space}
      summary={summaries[space.id]}
      onOpen={() => openSpace(space)}
      onOpenTab={(tab) => openSpace(space, tab)}
    />
  )

  return (
    <div className="h-full flex flex-col bg-background">
      <Header
        left={<span className="text-sm font-semibold text-foreground whitespace-nowrap">{t('Workspace')}</span>}
      />

      <div className="px-6 sm:px-10 pt-5 sm:pt-7 flex-shrink-0">
        <h1 className="text-xl font-semibold mb-1">{t('Workspace')}</h1>
        {/* Same copy as the header dropdown's tip (SpaceSelector.tsx) — one
            description of what a workspace is, not two that can drift. */}
        <p className="text-[13px] text-muted-foreground mb-5">
          {t('A workspace')}{' '}
          {t('is an isolated context for one project: its folder, conversations, knowledge base, digital humans, and installed skills. Create one per project, client, or goal to keep things separate and reusable.')}
        </p>
      </div>

      {/* Toolbar — same row layout as the capability walls' search toolbar,
          so filtering UI is consistent across list pages. */}
      <div className="flex-shrink-0 flex items-center gap-2 px-6 sm:px-10 py-2.5">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('Search workspaces')}
            className="w-full pl-9 pr-3 py-2 text-[13px] bg-card border border-border/60 rounded-lg focus:outline-none focus:border-primary focus:shadow-[inset_0_0_0_1px_var(--primary)] text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
        <button
          onClick={handleRefresh}
          disabled={summariesLoading}
          title={t('Refresh')}
          className="flex-shrink-0 p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${summariesLoading ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-[13px] border border-border/60 bg-card text-muted-foreground rounded-lg hover:text-foreground hover:border-border transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('New Workspace')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 sm:px-10 pb-10">
        {haloSpace && (
          <section className="mb-6">
            <h2 className="text-[11px] font-semibold text-subtle-foreground uppercase tracking-[0.06em] mb-2">
              {t('Default')}
            </h2>
            <div className={GRID_CLASSES}>
              {renderCard(haloSpace)}
            </div>
          </section>
        )}

        <section className="mb-6">
          <h2 className="text-[11px] font-semibold text-subtle-foreground uppercase tracking-[0.06em] mb-2">
            {t('My Workspaces')}
          </h2>
          {isSearching ? (
            filteredAvailable.length > 0 ? (
              <div className={GRID_CLASSES}>
                {filteredAvailable.map(renderCard)}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-8">{t('No matching results found')}</p>
            )
          ) : (
            <div className={GRID_CLASSES}>
              {/* `contents` keeps this wrapper out of the grid box model so
                  its sortable items and the trailing NewSpaceCard below are
                  siblings in the *same* grid, not two separate rows —
                  dnd-kit only measures the item nodes it owns, so this
                  doesn't affect drag behavior. */}
              <SortableSpaceList
                items={filteredAvailable}
                onReorder={(ids) => { void reorderSpaces(ids) }}
                className="contents"
                renderItem={renderCard}
              />
              <NewSpaceCard onClick={() => setShowCreateDialog(true)} />
            </div>
          )}
        </section>

        {filteredMissing.length > 0 && (
          <section>
            <h2 className="text-[11px] font-semibold text-subtle-foreground uppercase tracking-[0.06em] mb-2">
              {t('Disconnected')}
            </h2>
            <div className={GRID_CLASSES}>
              {filteredMissing.map(renderCard)}
            </div>
          </section>
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
