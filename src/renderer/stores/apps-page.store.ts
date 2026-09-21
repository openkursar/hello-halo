/**
 * Apps Page Navigation Store
 *
 * Manages UI-level state for AppsPage and StorePage:
 * - Which app is selected (AppsPage)
 * - Which detail panel is showing (AppsPage)
 * - Install dialog visibility (AppsPage)
 * - Store browsing state (StorePage — a separate top-level view, not an
 *   AppsPage tab; kept in this store rather than a new one so the two
 *   marketplace-opening actions below can carry filter state across the
 *   navigation in one atomic set())
 *
 * Intentionally separate from apps.store.ts (data) so that
 * page navigation changes don't cause unnecessary data re-fetches.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '../api'
import { useAppStore } from './app.store'
import { getCurrentLanguage } from '../i18n'
import { categoryTaxonomyResource, discoverPageResource } from '../lib/store-resources'
import { findInstalledApp, findEntryUpdate } from '../utils/store-install-state'
import { useAppsStore } from './apps.store'
import type { RegistryEntry, StoreAppDetail, UpdateInfo, StoreQuery, StoreQueryResponse, StoreInstallProgress } from '../../shared/store/store-types'
import type { AppType } from '../../shared/apps/spec-types'

/** The app types the store accepts a publication for. */
type PublishableAppType = Extract<AppType, 'automation' | 'skill'>

let storeListRequestSeq = 0
let storeDetailRequestSeq = 0

/**
 * Guards for the freshness check. The floor only swallows double-clicks on the
 * tab row — the check itself is conditional requests, so running it on every
 * arrival at a tab is the intended cost.
 */
const REVALIDATE_MIN_INTERVAL_MS = 2_000
let lastRevalidateAt = 0
let revalidateInFlight = false

/**
 * Last results per browse query, so returning to a tab paints immediately while
 * the refetch runs instead of blanking. Dropped on refresh, when the server
 * index itself has changed.
 *
 * Only browse combinations are cached. Search terms are excluded: they would
 * make the key space unbounded, and a search always warrants a fresh result.
 * `locale` is part of the key because the query returns localized entries.
 */
const storeListCache = new Map<string, { items: RegistryEntry[]; page: number; hasMore: boolean }>()

function storeListCacheKey(q: { category?: string; type?: string; locale?: string }): string {
  return `${q.locale ?? ''}|${q.type ?? ''}|${q.category ?? ''}`
}

/**
 * A detail fetch outlives the selection that started it: without invalidating
 * it, a slow response lands on a state the user already left, repainting the
 * detail they backed out of and counting a view for it.
 */
function abandonStoreDetail(): void {
  storeDetailRequestSeq++
}

/**
 * Reported from the action rather than from the detail view: every entry point
 * routes through here, while the view also remounts on things that are not an
 * open, such as leaving the store tab with a detail on screen and coming back.
 */
function reportDetailView(detail: StoreAppDetail, availableUpdates: UpdateInfo[]): void {
  const installedApp = findInstalledApp(detail.entry, detail.registryId, useAppsStore.getState().apps)
  const updateInfo = findEntryUpdate(installedApp, availableUpdates)
  void api.trackEvent('store.detail.view', {
    appId: detail.entry.slug,
    appType: detail.entry.type,
    installedState: updateInfo ? 'update' : installedApp ? 'installed' : 'new',
  })
}

// ============================================
// Types
// ============================================

export type AppsDetailViewType = 'activity-thread' | 'session-detail' | 'app-config' | 'mcp-status' | 'skill-info' | 'uninstalled-detail' | 'app-teams' | 'app-sessions' | 'bot-sessions'

export type AppsDetailView =
  | { type: 'activity-thread'; appId: string }
  | { type: 'session-detail'; appId: string; runId: string; sessionKey?: string }
  | { type: 'app-sessions'; appId: string }
  | { type: 'bot-sessions'; appId: string; instanceId: string }
  | { type: 'app-config'; appId: string }
  | { type: 'app-teams'; appId: string }
  | { type: 'mcp-status'; appId: string }
  | { type: 'skill-info'; appId: string }
  | { type: 'uninstalled-detail'; appId: string }
  | null

export type AppsPageTab = 'my-digital-humans' | 'team' | 'my-skills' | 'my-mcp' | 'inbox'

/**
 * Map an app type to its owning AppsPage tab.
 *
 * Implemented as an exhaustive switch so that adding a new `AppType` member
 * forces this function to be updated at compile time — preventing the
 * pre-fix scenario where a new type would silently fall through to the
 * digital-humans tab.
 */
export function tabForAppType(type: AppType): AppsPageTab {
  switch (type) {
    case 'skill':
      return 'my-skills'
    case 'mcp':
      return 'my-mcp'
    case 'automation':
      return 'my-digital-humans'
    case 'extension':
      // Extensions are a future/hidden category — surface them under digital
      // humans for now so existing install paths remain navigable, even
      // though no UI currently lists them as their own tab.
      return 'my-digital-humans'
  }
}

/** Which detail tab was last selected for automation apps (persisted to localStorage) */
export type AutomationDetailTab = 'activity' | 'config' | 'teams' | 'sessions'

// ============================================
// State Interface
// ============================================

interface AppsPageState {
  selectedAppId: string | null
  detailView: AppsDetailView
  /** Set externally (from badge/notification) before navigating to AppsPage */
  initialAppId: string | null
  showInstallDialog: boolean
  /**
   * Set by the task panel when a `waiting_user` digital-human item is
   * clicked, so the activity thread can scroll to and highlight the
   * specific EscalationCard instead of just landing on the feed's top.
   * Consumed once (mirrors storeAutoInstall).
   */
  pendingActivityScrollId: string | null
  /**
   * Set by a detail surface so the Settings tab can scroll to and briefly
   * highlight the settings group it summarizes (mirrors
   * pendingActivityScrollId). Consumed once.
   */
  pendingConfigScrollId: string | null

  // ── Tab State ──────────────────────────────
  currentTab: AppsPageTab
  /** Remembers which automation detail tab the user last selected (persisted) */
  lastAutomationTab: AutomationDetailTab

  // ── Store Tab State ────────────────────────
  storeApps: RegistryEntry[]
  storeLoading: boolean
  storeError: string | null
  storeSearchQuery: string
  storeCategory: string | null
  storeTypeFilter: AppType | null
  storePage: number
  storeHasMore: boolean
  /** True when the store's "My Publications" second-level view is open. */
  storeMineOpen: boolean
  storeSelectedSlug: string | null
  storeAutoInstall: boolean
  /** Pending "open the publish dialog pre-selected on this installed app"
   * intent, carried across navigation from a detail page's Share action and
   * consumed once by the store header (mirrors storeAutoInstall). */
  storePublishIntent: { type: PublishableAppType; appId: string } | null
  storeSelectedDetail: StoreAppDetail | null
  storeDetailLoading: boolean
  storeDetailError: string | null

  // ── Update Info ────────────────────────────
  availableUpdates: UpdateInfo[]

  // Actions
  selectApp: (appId: string, appType?: string) => void
  clearSelection: () => void
  openActivityThread: (appId: string) => void
  openSessionDetail: (appId: string, runId: string, sessionKey?: string) => void
  /** Open the External sessions tab (instance picker + session browser). */
  openAppSessions: (appId: string) => void
  /** Open the session browser (list + read-only chat) for one bound bot instance. */
  openBotSessions: (appId: string, instanceId: string) => void
  openAppConfig: (appId: string) => void
  openAppTeams: (appId: string) => void
  setInitialAppId: (appId: string | null) => void
  /** Navigate to an app's activity thread and scroll to a specific entry once there. */
  openActivityThreadAt: (appId: string, entryId: string) => void
  /** Consume the pending scroll-to-entry intent (returns it once, then clears). */
  consumePendingActivityScrollId: () => string | null
  /** Navigate to an app's Settings tab and scroll to a specific group once there. */
  openAppConfigAt: (appId: string, groupId: string) => void
  /** Consume the pending scroll-to-group intent (returns it once, then clears). */
  consumePendingConfigScrollId: () => string | null
  setShowInstallDialog: (show: boolean) => void
  reset: () => void

  // ── Store Actions ──────────────────────────
  setCurrentTab: (tab: AppsPageTab) => void
  loadStoreApps: (query?: StoreQuery) => Promise<void>
  seedStoreApps: (items: RegistryEntry[], hasMore: boolean) => void
  revalidateStore: () => Promise<void>
  loadMoreStoreApps: () => Promise<void>
  setStoreSearch: (query: string) => void
  setStoreCategory: (category: string | null) => void
  setStoreTypeFilter: (type: AppType | null) => void
  setStoreMineOpen: (open: boolean) => void
  /**
   * Switch to the Marketplace tab pre-filtered by the given app type and
   * force a fresh fetch so the listing matches the new filter. Use this
   * for programmatic navigation from outside the marketplace (e.g. empty
   * state CTAs, home Studio card). Mirrors the inline pattern in
   * StoreHeader.handleTypeFilterClick — kept as one action so callers can
   * never forget the reload step.
   */
  openMarketplaceFilteredBy: (type: AppType | null) => Promise<void>
  selectStoreApp: (slug: string, autoInstall?: boolean) => Promise<void>
  clearStoreSelection: () => void
  /** Consume the "open install dialog on arrival" intent set by a card's install button. */
  consumeStoreAutoInstall: () => boolean
  /** Navigate to the store and request the publish dialog open pre-selected on
   * the given installed app (used by a detail page's Share action). */
  openStorePublish: (type: PublishableAppType, appId: string) => void
  /** Consume the publish-dialog intent (returns it once, then clears). */
  consumeStorePublishIntent: () => { type: PublishableAppType; appId: string } | null
  installFromStore: (slug: string, spaceId: string | null, userConfig?: Record<string, unknown>, onProgress?: (progress: StoreInstallProgress) => void) => Promise<string | null>
  refreshStore: () => Promise<void>
  checkUpdates: () => Promise<void>
}

// ============================================
// Store
// ============================================

export const useAppsPageStore = create<AppsPageState>()(
  persist(
    (set, get) => ({
  selectedAppId: null,
  detailView: null,
  pendingActivityScrollId: null,
  pendingConfigScrollId: null,
  initialAppId: null,
  showInstallDialog: false,

  // ── Tab State ──────────────────────────────
  currentTab: 'my-digital-humans',
  lastAutomationTab: 'activity',

  // ── Store Tab State ────────────────────────
  storeApps: [],
  storeLoading: false,
  storeError: null,
  storeSearchQuery: '',
  storeCategory: null,
  storeTypeFilter: null,
  storePage: 1,
  storeHasMore: false,
  storeMineOpen: false,
  storeSelectedSlug: null,
  storeAutoInstall: false,
  storePublishIntent: null,
  storeSelectedDetail: null,
  storeDetailLoading: false,
  storeDetailError: null,

  // ── Update Info ────────────────────────────
  availableUpdates: [],

  selectApp: (appId, appType) => {
    // Looked up here rather than trusted from the caller: every card wall
    // computes `appType` from `app.spec.type`, which doesn't change on
    // uninstall (only `app.status` does) — so a caller-supplied type can
    // never actually route to 'uninstalled-detail' on its own, no matter
    // what card wall it's clicked from.
    const isUninstalled = appType === 'uninstalled'
      || useAppsStore.getState().apps.find(a => a.id === appId)?.status === 'uninstalled'

    let detailView: AppsDetailView = { type: 'activity-thread', appId }
    if (isUninstalled) detailView = { type: 'uninstalled-detail', appId }
    else if (appType === 'mcp') detailView = { type: 'mcp-status', appId }
    else if (appType === 'skill') detailView = { type: 'skill-info', appId }
    else if (appType === 'uninstalled') detailView = { type: 'uninstalled-detail', appId }
    else {
      // Automation apps: restore last selected tab
      const tab = get().lastAutomationTab
      if (tab === 'config') detailView = { type: 'app-config', appId }
      else if (tab === 'teams') detailView = { type: 'app-teams', appId }
      else if (tab === 'sessions') detailView = { type: 'app-sessions', appId }
      // else default 'activity' → activity-thread (already set)
    }
    set({ selectedAppId: appId, detailView })
  },

  clearSelection: () => set({ selectedAppId: null, detailView: null }),

  openActivityThread: (appId) =>
    set({ selectedAppId: appId, detailView: { type: 'activity-thread', appId } }),

  openActivityThreadAt: (appId, entryId) =>
    set({ selectedAppId: appId, detailView: { type: 'activity-thread', appId }, pendingActivityScrollId: entryId }),

  consumePendingActivityScrollId: () => {
    const id = get().pendingActivityScrollId
    if (id) set({ pendingActivityScrollId: null })
    return id
  },

  openSessionDetail: (appId, runId, sessionKey) =>
    set({ selectedAppId: appId, detailView: { type: 'session-detail', appId, runId, sessionKey } }),

  openAppSessions: (appId) =>
    set({ selectedAppId: appId, detailView: { type: 'app-sessions', appId }, lastAutomationTab: 'sessions' }),

  openBotSessions: (appId, instanceId) =>
    set({ selectedAppId: appId, detailView: { type: 'bot-sessions', appId, instanceId } }),

  openAppConfig: (appId) =>
    set({ selectedAppId: appId, detailView: { type: 'app-config', appId }, lastAutomationTab: 'config' }),

  openAppConfigAt: (appId, groupId) =>
    set({ selectedAppId: appId, detailView: { type: 'app-config', appId }, pendingConfigScrollId: groupId }),

  consumePendingConfigScrollId: () => {
    const id = get().pendingConfigScrollId
    if (id) set({ pendingConfigScrollId: null })
    return id
  },

  openAppTeams: (appId) => set({ selectedAppId: appId, detailView: { type: 'app-teams', appId }, lastAutomationTab: 'teams' }),

  setInitialAppId: (appId) => set({ initialAppId: appId }),

  setShowInstallDialog: (show) => set({ showInstallDialog: show }),

  reset: () => {
    abandonStoreDetail()
    set({
      selectedAppId: null,
      detailView: null,
      pendingActivityScrollId: null,
      pendingConfigScrollId: null,
      initialAppId: null,
      showInstallDialog: false,
      currentTab: 'my-digital-humans',
      storeApps: [],
      storeLoading: false,
      storeError: null,
      storeSearchQuery: '',
      storeCategory: null,
      storeTypeFilter: null,
      storePage: 1,
      storeHasMore: false,
      storeSelectedSlug: null,
      storeSelectedDetail: null,
      storeDetailLoading: false,
      storeDetailError: null,
      availableUpdates: [],
    })
  },

  // ── Store Actions ──────────────────────────

  setCurrentTab: (tab) => set({ currentTab: tab }),

  /**
   * Freshness check for every arrival at a store tab. The index is revalidated
   * with the validators it was fetched with, so an unchanged store answers 304
   * and costs nothing but the round trip.
   *
   * A changed index reloads the visible list rather than only dropping the
   * cache: an operator hiding an app must disappear from the grid the user is
   * looking at, not on their next navigation. The ops-managed page documents
   * are re-read either way, because they can change while the index does not.
   */
  revalidateStore: async () => {
    const now = Date.now()
    if (revalidateInFlight || now - lastRevalidateAt < REVALIDATE_MIN_INTERVAL_MS) return
    revalidateInFlight = true
    lastRevalidateAt = now
    try {
      const res = await api.storeRevalidate()
      if (!res.success) return
      discoverPageResource.invalidate()
      categoryTaxonomyResource.invalidate()
      if (res.data?.changed) {
        storeListCache.clear()
        await get().loadStoreApps()
      }
    } catch (err) {
      console.warn('[AppsPageStore] revalidateStore failed:', err)
    } finally {
      revalidateInFlight = false
    }
  },

  /**
   * Adopt the catalog page carried by the discover payload so the grid and the
   * curated sections describe the same snapshot, and warm the browse cache with
   * it. Skipped while a search or filter is active (that list is not the
   * catalog) or while a browse request is in flight, whose newer result wins.
   */
  seedStoreApps: (items, hasMore) => {
    const { storeSearchQuery, storeCategory, storeTypeFilter, storeLoading } = get()
    if (storeSearchQuery || storeCategory || storeTypeFilter || storeLoading) return
    set({ storeApps: items, storeHasMore: hasMore, storePage: 1 })
    storeListCache.set(storeListCacheKey({ locale: getCurrentLanguage() }), { items, page: 1, hasMore })
  },

  loadStoreApps: async (query) => {
    const requestId = ++storeListRequestSeq
    const locale = getCurrentLanguage()
    const baseQuery = query ?? {
      search: get().storeSearchQuery || undefined,
      category: get().storeCategory ?? undefined,
      type: get().storeTypeFilter ?? undefined,
    }
    const cacheKey = baseQuery.search ? null : storeListCacheKey({ ...baseQuery, locale })
    const cached = cacheKey ? storeListCache.get(cacheKey) : undefined
    set(cached
      ? { storeLoading: true, storeError: null, storeApps: cached.items, storePage: cached.page, storeHasMore: cached.hasMore }
      : { storeLoading: true, storeError: null, storeApps: [], storePage: 1, storeHasMore: false })
    try {
      if (baseQuery.type) {
        const requestQuery = { ...baseQuery, locale, page: 1, pageSize: 30 }
        const res = await api.storeQuery(requestQuery)
        if (requestId !== storeListRequestSeq) {
          return
        }

        if (res.success && res.data) {
          const data = res.data as StoreQueryResponse
          set({ storeApps: data.items, storeHasMore: data.hasMore, storePage: 1 })
          if (cacheKey) storeListCache.set(cacheKey, { items: data.items, page: 1, hasMore: data.hasMore })
        } else {
          set({ storeError: (res.error as string) || 'Failed to load store apps' })
        }
        return
      }

      // All tab: query each type independently and render whichever returns first.
      const typeOrder: AppType[] = ['automation', 'skill', 'mcp']
      const typeResults: Partial<Record<AppType, StoreQueryResponse>> = {}
      const errors: string[] = []

      const applyPartialResults = () => {
        if (requestId !== storeListRequestSeq) return
        const merged = typeOrder.flatMap(type => typeResults[type]?.items ?? [])
        set({ storeApps: merged, storePage: 1, storeHasMore: false })
      }

      await Promise.all(typeOrder.map(async (type) => {
        try {
          const res = await api.storeQuery({
            search: baseQuery.search,
            category: baseQuery.category,
            type,
            locale,
            page: 1,
            pageSize: 30,
          })

          if (requestId !== storeListRequestSeq) return
          if (res.success && res.data) {
            typeResults[type] = res.data as StoreQueryResponse
            // Streaming in would shrink an already-painted cached list before
            // regrowing it, so only do it when there was nothing to show.
            if (!cached) applyPartialResults()
          } else {
            errors.push(`${type}: ${(res.error as string) || 'query failed'}`)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`${type}: ${msg}`)
        }
      }))

      if (requestId !== storeListRequestSeq) return

      const merged = typeOrder.flatMap(type => typeResults[type]?.items ?? [])
      if (merged.length === 0 && errors.length > 0) {
        // Every type failed — keep whatever is on screen rather than blanking it.
        set({ storeError: `Failed to load store apps (${errors.join('; ')})` })
        return
      }
      if (cached) set({ storeApps: merged, storePage: 1, storeHasMore: false })
      if (cacheKey) storeListCache.set(cacheKey, { items: merged, page: 1, hasMore: false })
    } catch (err) {
      if (requestId !== storeListRequestSeq) return
      console.error('[AppsPageStore] loadStoreApps error:', err)
      set({ storeError: 'Failed to load store apps' })
    } finally {
      if (requestId === storeListRequestSeq) {
        set({ storeLoading: false })
      }
    }
  },

  loadMoreStoreApps: async () => {
    const { storeHasMore, storeLoading, storePage } = get()
    if (!storeHasMore || storeLoading) return

    const requestId = ++storeListRequestSeq
    set({ storeLoading: true })
    try {
      const locale = getCurrentLanguage()
      const nextPage = storePage + 1
      const requestQuery = {
        search: get().storeSearchQuery || undefined,
        category: get().storeCategory ?? undefined,
        type: get().storeTypeFilter ?? undefined,
        locale,
        page: nextPage,
        pageSize: 30,
      }
      const res = await api.storeQuery(requestQuery)
      if (requestId !== storeListRequestSeq) {
        return
      }

      if (res.success && res.data) {
        const data = res.data as StoreQueryResponse
        const items = [...get().storeApps, ...data.items]
        set({ storeApps: items, storeHasMore: data.hasMore, storePage: nextPage })
        if (!requestQuery.search) {
          storeListCache.set(storeListCacheKey(requestQuery), { items, page: nextPage, hasMore: data.hasMore })
        }
      }
    } catch (err) {
      if (requestId !== storeListRequestSeq) return
      console.error('[AppsPageStore] loadMoreStoreApps error:', err)
    } finally {
      if (requestId === storeListRequestSeq) {
        set({ storeLoading: false })
      }
    }
  },

  setStoreSearch: (query) => set({ storeSearchQuery: query }),

  setStoreCategory: (category) => set({ storeCategory: category }),

  setStoreTypeFilter: (type) => set({ storeTypeFilter: type }),
  setStoreMineOpen: (open) => set({ storeMineOpen: open }),

  openMarketplaceFilteredBy: async (type) => {
    // Set the filter before kicking off the fetch so the marketplace UI
    // renders with it already applied while the new list is loading, then
    // navigate the shell to StorePage — a separate top-level view (store =
    // getting something new, not one of "my-X" I already own). Cross-store
    // call (apps-page.store -> app.store, new dependency edge, LAWS L3):
    // every caller of this action wants the navigation, and a store action
    // is the one place that can guarantee it happens instead of relying on
    // each of the four call sites to remember to add it themselves.
    set({ storeTypeFilter: type })
    useAppStore.getState().navigate('store')
    await get().loadStoreApps()
  },

  selectStoreApp: async (slug, autoInstall = false) => {
    const requestId = ++storeDetailRequestSeq
    set({ storeSelectedSlug: slug, storeAutoInstall: autoInstall, storeDetailLoading: true, storeSelectedDetail: null, storeDetailError: null })
    try {
      const res = await api.storeGetAppDetail(slug)
      if (requestId !== storeDetailRequestSeq) return

      if (res.success && res.data) {
        const detail = res.data as StoreAppDetail
        set({ storeSelectedDetail: detail })
        reportDetailView(detail, get().availableUpdates)
      } else {
        console.error('[AppsPageStore] selectStoreApp failed:', res.error)
        set({ storeDetailError: (res.error as string) || 'Failed to load app detail' })
      }
    } catch (err) {
      if (requestId !== storeDetailRequestSeq) return
      console.error('[AppsPageStore] selectStoreApp error:', err)
      set({ storeDetailError: 'Failed to load app detail' })
    } finally {
      // A superseded response must not clear the flag its successor is still
      // waiting on, or the detail renders as not-found until that one lands.
      if (requestId === storeDetailRequestSeq) set({ storeDetailLoading: false })
    }
  },

  clearStoreSelection: () => {
    abandonStoreDetail()
    set({
      storeSelectedSlug: null,
      storeAutoInstall: false,
      storeSelectedDetail: null,
      storeDetailLoading: false,
      storeDetailError: null,
      storeError: null,
    })
  },

  consumeStoreAutoInstall: () => {
    if (!get().storeAutoInstall) return false
    set({ storeAutoInstall: false })
    return true
  },

  openStorePublish: (type, appId) => {
    // Navigate to StorePage (same cross-store edge as openMarketplaceFilteredBy
    // above, LAWS L3) and surface its header, which owns the publish dialog:
    // leave any detail/mine sub-view so StoreHeader renders and can consume
    // the intent.
    abandonStoreDetail()
    useAppStore.getState().navigate('store')
    set({
      storeMineOpen: false,
      storeSelectedSlug: null,
      storePublishIntent: { type, appId },
    })
  },

  consumeStorePublishIntent: () => {
    const intent = get().storePublishIntent
    if (intent) set({ storePublishIntent: null })
    return intent
  },

  installFromStore: async (slug, spaceId, userConfig, onProgress) => {
    try {
      const res = await api.storeInstall(slug, spaceId, userConfig, onProgress)
      if (res.success && (res.data as { appId?: string })?.appId) {
        set({ storeError: null })
        return (res.data as { appId: string }).appId
      }
      const errorMsg = (res.error as string) || 'Installation failed'
      set({ storeError: errorMsg })
      throw new Error(errorMsg)
    } catch (err) {
      if (err instanceof Error && get().storeError) throw err
      console.error('[AppsPageStore] installFromStore error:', err)
      const msg = err instanceof Error ? err.message : 'Installation failed'
      set({ storeError: msg })
      throw new Error(msg)
    }
  },

  refreshStore: async () => {
    try {
      const res = await api.storeRefresh()
      if (!res.success) {
        set({ storeError: (res.error as string) || 'Failed to refresh store index' })
        return
      }
      // Scene categories, collections and the discover layout are ops-managed
      // server-side; refetch them alongside the index.
      storeListCache.clear()
      discoverPageResource.invalidate()
      categoryTaxonomyResource.invalidate()
      // Reload store apps after refresh
      await get().loadStoreApps()
      await get().checkUpdates()
    } catch (err) {
      console.error('[AppsPageStore] refreshStore error:', err)
      set({ storeError: 'Failed to refresh store index' })
    }
  },

  checkUpdates: async () => {
    try {
      const res = await api.storeCheckUpdates()
      if (res.success && res.data) {
        set({ availableUpdates: res.data as UpdateInfo[] })
      } else if (!res.success) {
        console.warn('[AppsPageStore] checkUpdates failed:', res.error)
      }
    } catch (err) {
      console.error('[AppsPageStore] checkUpdates error:', err)
    }
  },
}),
    {
      name: 'halo-apps-page',
      // Only persist the user's last automation tab preference
      partialize: (state) => ({
        lastAutomationTab: state.lastAutomationTab,
      }),
    }
  )
)
