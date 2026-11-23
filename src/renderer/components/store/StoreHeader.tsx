/**
 * Store Header
 *
 * Search input and type filter tabs for the store. Category chips live in the
 * content area (StoreCategoryBar) so they sit on the gray band rather than the
 * white header. The command-line tools tab shares the row but reads its own
 * catalog, so it is a separate view rather than a type filter.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, RefreshCw, Upload, ChevronRight } from 'lucide-react'
import { api } from '../../api'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useStoreCapabilities } from '../../hooks/useStoreCapabilities'
import { useTranslation } from '../../i18n'
import type { AppType } from '../../../shared/apps/spec-types'
import { ShareToStoreDialog } from './ShareToStoreDialog'

type MainTabId = 'discover' | AppType

const MAIN_TABS: MainTabId[] = ['discover', 'automation', 'skill', 'mcp']

/** Literal t() per tab so i18next-parser can extract the labels. */
function tabLabel(t: (key: string) => string, id: MainTabId): string {
  switch (id) {
    case 'discover': return t('Discover')
    case 'automation': return t('Digital Human')
    case 'skill': return t('Skill')
    case 'mcp': return t('MCP')
    default: return id
  }
}

/**
 * Primary publish entry point — opens the unified Share-to-Store dialog.
 * Gated on `capabilities.publish`: hidden when the build has no configured
 * publish target. Local package import lives on AppsPage → Manual Add instead.
 */
function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 h-[34px] px-3.5 border-b-2 -mb-px text-[13px] font-medium transition-colors ease-halo ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-subtle-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function PublishButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className="flex flex-shrink-0 items-center gap-1.5 px-3 py-2 text-[13px] border border-border-soft bg-card text-muted-foreground rounded-lg hover:text-foreground hover:border-border transition-colors"
      title={t('Publish your Digital Human or Skill to the store')}
      aria-label={t('Publish App')}
    >
      <Upload className="w-4 h-4" />
      <span className="hidden sm:inline">{t('Publish App')}</span>
    </button>
  )
}

interface StoreHeaderProps {
  /** Replaces the store refresh, for a tab that reads another catalog. */
  onRefresh?: () => void
}

export function StoreHeader({ onRefresh }: StoreHeaderProps = {}) {
  const { t } = useTranslation()
  const capabilities = useStoreCapabilities()
  const storeSearchQuery = useAppsPageStore(state => state.storeSearchQuery)
  const storeTypeFilter = useAppsPageStore(state => state.storeTypeFilter)
  const storeLoading = useAppsPageStore(state => state.storeLoading)
  const storeCliOpen = useAppsPageStore(state => state.storeCliOpen)
  const setStoreSearch = useAppsPageStore(state => state.setStoreSearch)
  const setStoreCategory = useAppsPageStore(state => state.setStoreCategory)
  const setStoreTypeFilter = useAppsPageStore(state => state.setStoreTypeFilter)
  const loadStoreApps = useAppsPageStore(state => state.loadStoreApps)
  const revalidateStore = useAppsPageStore(state => state.revalidateStore)
  const refreshStore = useAppsPageStore(state => state.refreshStore)
  const setStoreMineOpen = useAppsPageStore(state => state.setStoreMineOpen)
  const setStoreCliOpen = useAppsPageStore(state => state.setStoreCliOpen)

  const consumeStorePublishIntent = useAppsPageStore(state => state.consumeStorePublishIntent)
  const storePublishIntent = useAppsPageStore(state => state.storePublishIntent)

  const [showShareDialog, setShowShareDialog] = useState(false)
  // Pre-selection carried from a detail page's Share action.
  const [publishPreselect, setPublishPreselect] = useState<ReturnType<typeof consumeStorePublishIntent>>(null)

  // A detail page's Share routed here — open the publish dialog pre-selected on
  // that app (consume the one-shot intent so it doesn't re-fire).
  useEffect(() => {
    if (!storePublishIntent) return
    const intent = consumeStorePublishIntent()
    if (!intent) return
    setPublishPreselect(intent)
    setShowShareDialog(true)
  }, [storePublishIntent, consumeStorePublishIntent])

  // Publish and "My Publications" open directly; the sign-in prompt lives inside
  // each surface (ShareToStoreDialog / StoreMine) so users see the page first.

  // Debounce timer ref for search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced search: triggers loadStoreApps 300ms after typing stops
  const handleSearchChange = useCallback((value: string) => {
    setStoreSearch(value)
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    // The command-line tools tab filters its own list as the query changes.
    if (useAppsPageStore.getState().storeCliOpen) return
    debounceRef.current = setTimeout(() => {
      const state = useAppsPageStore.getState()
      void Promise.resolve(
        loadStoreApps({ search: value || undefined, category: state.storeCategory ?? undefined, type: state.storeTypeFilter ?? undefined }),
      ).then(() => {
        if (value) {
          void api.trackEvent('store.search', {
            resultCount: useAppsPageStore.getState().storeApps.length,
            tabScope: state.storeTypeFilter ?? 'discover',
          })
        }
      })
    }, 300)
  }, [setStoreSearch, loadStoreApps])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  const handleTabClick = useCallback((tabId: MainTabId) => {
    const nextType = tabId === 'discover' ? null : tabId
    const state = useAppsPageStore.getState()
    if (!state.storeCliOpen && state.storeTypeFilter === nextType && !state.storeSearchQuery && !state.storeCategory) return
    setStoreCliOpen(false)
    setStoreTypeFilter(nextType)
    setStoreCategory(null)
    setStoreSearch('')
    // Paint from the local mirror first, then check the server. The check only
    // repaints when the index actually moved, so switching tabs stays instant.
    loadStoreApps({ type: nextType ?? undefined })
    void revalidateStore()
  }, [setStoreCliOpen, setStoreTypeFilter, setStoreCategory, setStoreSearch, loadStoreApps, revalidateStore])

  const handleCliTabClick = useCallback(() => {
    if (useAppsPageStore.getState().storeCliOpen) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setStoreSearch('')
    setStoreCliOpen(true)
  }, [setStoreSearch, setStoreCliOpen])

  return (
    <div className="flex flex-col gap-3 mx-6 sm:mx-10 pt-3 flex-shrink-0">
      {/* Search + Refresh row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={storeSearchQuery}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder={storeCliOpen ? t('Search command-line tools') : t('Search Digital Humans / Skills / MCP')}
            className="w-full pl-9 pr-3 py-2 text-[13px] bg-card border border-border-soft rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
        <button
          onClick={onRefresh ?? refreshStore}
          disabled={!onRefresh && storeLoading}
          className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-lg transition-colors disabled:opacity-50"
          title={t('Refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${!onRefresh && storeLoading ? 'animate-spin' : ''}`} />
        </button>
        {capabilities?.publish && (
          <PublishButton onClick={() => { setPublishPreselect(null); setShowShareDialog(true) }} />
        )}
        {capabilities?.identity === 'account' && (
          <button
            onClick={() => setStoreMineOpen(true)}
            className="flex flex-shrink-0 items-center gap-1 px-3.5 py-2 text-[13px] border border-border-soft bg-card text-muted-foreground hover:text-foreground hover:border-border rounded-lg transition-colors"
            title={t('My Publications')}
          >
            <span>{t('Mine')}</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Main tabs — underline style, matching AppsPage's `.tabs` row: the
          active tab carries its own 2px accent rule on top of the shared
          bottom divider (prototype `.tabs{border-bottom:1px solid border}`). */}
      <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
        {MAIN_TABS.map(tab => (
          <TabButton
            key={tab}
            active={!storeCliOpen && (tab === 'discover' ? storeTypeFilter === null : storeTypeFilter === tab)}
            onClick={() => handleTabClick(tab)}
          >
            {tabLabel(t, tab)}
          </TabButton>
        ))}
        {capabilities?.cliTools && (
          <TabButton active={storeCliOpen} onClick={handleCliTabClick}>
            {t('CLI tools')}
          </TabButton>
        )}
      </div>

      {showShareDialog && (
        <ShareToStoreDialog
          initialType={publishPreselect?.type}
          initialAppId={publishPreselect?.appId}
          initialSpec={publishPreselect?.specOverride}
          entry={publishPreselect ? 'share' : 'store'}
          onClose={() => { setShowShareDialog(false); setPublishPreselect(null) }}
        />
      )}
    </div>
  )
}
