/**
 * Apps Page Navigation Store
 *
 * Manages UI-level state within the AppsPage:
 * - Which app is selected
 * - Which detail panel is showing
 * - Install dialog visibility
 * - Store tab browsing state
 *
 * Intentionally separate from apps.store.ts (data) so that
 * page navigation changes don't cause unnecessary data re-fetches.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '../api'
import { getCurrentLanguage } from '../i18n'
import type { RegistryEntry, StoreAppDetail, UpdateInfo, StoreQuery, StoreQueryResponse, StoreInstallProgress } from '../../shared/store/store-types'
import type { AppType } from '../../shared/apps/spec-types'
import type { ImSessionRecord } from '../../shared/types/im-channel'

let storeListRequestSeq = 0
let storeDetailRequestSeq = 0

// ============================================
// Types
// ============================================

export type AppsDetailViewType = 'activity-thread' | 'session-detail' | 'app-chat' | 'app-config' | 'mcp-status' | 'skill-info' | 'uninstalled-detail'

export type AppsDetailView =
  | { type: 'activity-thread'; appId: string }
  | { type: 'session-detail'; appId: string; runId: string; sessionKey: string }
  | { type: 'app-chat'; appId: string; spaceId: string }
  | { type: 'app-config'; appId: string }
  | { type: 'mcp-status'; appId: string }
  | { type: 'skill-info'; appId: string }
  | { type: 'uninstalled-detail'; appId: string }
  | null

export type AppsPageTab = 'my-digital-humans' | 'my-skills' | 'my-mcp' | 'store'

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
export type AutomationDetailTab = 'activity' | 'chat' | 'config'

// ============================================
// State Interface
// ============================================

interface AppsPageState {
  selectedAppId: string | null
  detailView: AppsDetailView
  /** Set externally (from badge/notification) before navigating to AppsPage */
  initialAppId: string | null
  showInstallDialog: boolean

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
  storeSelectedSlug: string | null
  storeSelectedDetail: StoreAppDetail | null
  storeDetailLoading: boolean
  storeDetailError: string | null

  // ── Update Info ────────────────────────────
  availableUpdates: UpdateInfo[]

  // ── IM Session Panel ────────────────────────
  imPanelOpen: boolean
  selectedImSession: ImSessionRecord | null
  imSessions: ImSessionRecord[]
  imSessionsAppId: string | null

  // Actions
  selectApp: (appId: string, appType?: string, spaceId?: string) => void
  clearSelection: () => void
  openActivityThread: (appId: string) => void
  openSessionDetail: (appId: string, runId: string, sessionKey: string) => void
  openAppChat: (appId: string, spaceId: string) => void
  openAppConfig: (appId: string) => void
  setInitialAppId: (appId: string | null) => void
  setShowInstallDialog: (show: boolean) => void
  toggleImPanel: () => void
  selectImSession: (session: ImSessionRecord | null) => void
  fetchImSessions: (appId: string) => Promise<void>
  reset: () => void

  // ── Store Actions ──────────────────────────
  setCurrentTab: (tab: AppsPageTab) => void
  loadStoreApps: (query?: StoreQuery) => Promise<void>
  loadMoreStoreApps: () => Promise<void>
  setStoreSearch: (query: string) => void
  setStoreCategory: (category: string | null) => void
  setStoreTypeFilter: (type: AppType | null) => void
  /**
   * Switch to the Marketplace tab pre-filtered by the given app type and
   * force a fresh fetch so the listing matches the new filter. Use this
   * for programmatic navigation from outside the marketplace (e.g. empty
   * state CTAs, home Studio card). Mirrors the inline pattern in
   * StoreHeader.handleTypeFilterClick — kept as one action so callers can
   * never forget the reload step.
   */
  openMarketplaceFilteredBy: (type: AppType | null) => Promise<void>
  selectStoreApp: (slug: string) => Promise<void>
  clearStoreSelection: () => void
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
  storeSelectedSlug: null,
  storeSelectedDetail: null,
  storeDetailLoading: false,
  storeDetailError: null,

  // ── Update Info ────────────────────────────
  availableUpdates: [],

  // ── IM Session Panel ────────────────────────
  imPanelOpen: true,
  selectedImSession: null,
  imSessions: [],
  imSessionsAppId: null,

  selectApp: (appId, appType, spaceId) => {
    let detailView: AppsDetailView = { type: 'activity-thread', appId }
    if (appType === 'mcp') detailView = { type: 'mcp-status', appId }
    else if (appType === 'skill') detailView = { type: 'skill-info', appId }
    else if (appType === 'uninstalled') detailView = { type: 'uninstalled-detail', appId }
    else {
      // Automation apps: restore last selected tab
      const tab = get().lastAutomationTab
      if (tab === 'chat' && spaceId) detailView = { type: 'app-chat', appId, spaceId }
      else if (tab === 'config') detailView = { type: 'app-config', appId }
      // else default 'activity' → activity-thread (already set)
    }
    set({ selectedAppId: appId, detailView })
  },

  clearSelection: () => set({ selectedAppId: null, detailView: null }),

  openActivityThread: (appId) =>
    set({ selectedAppId: appId, detailView: { type: 'activity-thread', appId }, lastAutomationTab: 'activity' }),

  openSessionDetail: (appId, runId, sessionKey) =>
    set({ selectedAppId: appId, detailView: { type: 'session-detail', appId, runId, sessionKey } }),

  openAppChat: (appId, spaceId) =>
    set({ selectedAppId: appId, detailView: { type: 'app-chat', appId, spaceId }, lastAutomationTab: 'chat' }),

  openAppConfig: (appId) =>
    set({ selectedAppId: appId, detailView: { type: 'app-config', appId }, lastAutomationTab: 'config' }),

  setInitialAppId: (appId) => set({ initialAppId: appId }),

  setShowInstallDialog: (show) => set({ showInstallDialog: show }),

  toggleImPanel: () => set(s => ({ imPanelOpen: !s.imPanelOpen })),

  selectImSession: (session) => set({ selectedImSession: session }),

  fetchImSessions: async (appId) => {
    try {
      const res = await api.imSessionsList(appId)
      if (res.success && Array.isArray(res.data)) {
        const sorted = (res.data as ImSessionRecord[]).sort(
          (a, b) => b.lastActiveAt - a.lastActiveAt
        )
        set({ imSessions: sorted, imSessionsAppId: appId })
      }
    } catch (err) {
      console.error('[AppsPageStore] fetchImSessions error:', err)
    }
  },

  reset: () => set({
    selectedAppId: null,
    detailView: null,
    initialAppId: null,
    showInstallDialog: false,
    currentTab: 'my-digital-humans',
    imPanelOpen: true,
    selectedImSession: null,
    imSessions: [],
    imSessionsAppId: null,
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
  }),

  // ── Store Actions ──────────────────────────

  setCurrentTab: (tab) => set({ currentTab: tab }),

  loadStoreApps: async (query) => {
    const requestId = ++storeListRequestSeq
    set({ storeLoading: true, storeError: null, storeApps: [], storePage: 1, storeHasMore: false })
    try {
      const locale = getCurrentLanguage()
      const baseQuery = query ?? {
        search: get().storeSearchQuery || undefined,
        category: get().storeCategory ?? undefined,
        type: get().storeTypeFilter ?? undefined,
      }

      if (baseQuery.type) {
        const requestQuery = { ...baseQuery, locale, page: 1, pageSize: 30 }
        const res = await api.storeQuery(requestQuery)
        if (requestId !== storeListRequestSeq) {
          return
        }

        if (res.success && res.data) {
          const data = res.data as StoreQueryResponse
          set({ storeApps: data.items, storeHasMore: data.hasMore, storePage: 1 })
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
            applyPartialResults()
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
        set({ storeError: `Failed to load store apps (${errors.join('; ')})` })
      }
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
        set({
          storeApps: [...get().storeApps, ...data.items],
          storeHasMore: data.hasMore,
          storePage: nextPage,
        })
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

  openMarketplaceFilteredBy: async (type) => {
    // Set filter + tab atomically before kicking off the fetch so the
    // marketplace UI renders with the new filter already applied while
    // the new list is loading.
    set({ storeTypeFilter: type, currentTab: 'store' })
    await get().loadStoreApps()
  },

  selectStoreApp: async (slug) => {
    const requestId = ++storeDetailRequestSeq
    set({ storeSelectedSlug: slug, storeDetailLoading: true, storeSelectedDetail: null, storeDetailError: null })
    try {
      const res = await api.storeGetAppDetail(slug)
      if (requestId !== storeDetailRequestSeq) return

      if (res.success && res.data) {
        set({ storeSelectedDetail: res.data as StoreAppDetail })
      } else {
        console.error('[AppsPageStore] selectStoreApp failed:', res.error)
        set({ storeDetailError: (res.error as string) || 'Failed to load app detail' })
      }
    } catch (err) {
      if (requestId !== storeDetailRequestSeq) return
      console.error('[AppsPageStore] selectStoreApp error:', err)
      set({ storeDetailError: 'Failed to load app detail' })
    } finally {
      set({ storeDetailLoading: false })
    }
  },

  clearStoreSelection: () => set({
    storeSelectedSlug: null,
    storeSelectedDetail: null,
    storeDetailLoading: false,
    storeDetailError: null,
    storeError: null,
  }),

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
