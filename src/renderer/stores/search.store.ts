/**
 * Search Store - Zustand store for managing search UI state
 *
 * Manages:
 * - Search panel visibility (full screen edit mode)
 * - Current search query
 * - Current search scope
 * - Search results
 * - Loading state
 *
 * New: Highlight bar state
 * - Whether highlight bar is visible (navigation mode)
 * - Current result index (for navigation)
 * - Original search query and results (for navigation context)
 */

import { create } from 'zustand'

export type SearchScope = 'conversation' | 'space' | 'global'

interface SearchResult {
  conversationId: string
  conversationTitle: string
  messageId: string
  spaceId: string
  spaceName: string
  messageRole: 'user' | 'assistant'
  messageContent: string
  messageTimestamp: string
  matchCount: number
  contextBefore?: string
  contextAfter?: string
}

interface SearchState {
  // ===== Search Panel State (Full Screen Edit Mode) =====
  isSearchOpen: boolean
  searchScope: SearchScope
  query: string // Current input value (UI state)
  searchedQuery: string // Query that produced current results (result metadata)
  results: SearchResult[] | null // null = not searched yet, [] = searched but no results
  isSearching: boolean
  progress: { current: number; total: number }

  // ===== Highlight Bar State (Navigation Mode) =====
  isHighlightBarVisible: boolean
  currentResultIndex: number // 0-based index of currently highlighted result
  highlightQuery: string // The query that was used for current highlights
  highlightResults: SearchResult[] // Results for current highlights

  // ===== Actions =====
  // Search panel (edit mode)
  openSearch: (scope?: SearchScope) => void
  closeSearch: () => void
  resetSearch: () => void // Clear search completely (for new search, not for reopening)
  setQuery: (query: string) => void
  setScope: (scope: SearchScope) => void
  setResults: (results: SearchResult[] | null) => void
  setSearchedQuery: (query: string) => void
  setIsSearching: (isSearching: boolean) => void
  setProgress: (progress: { current: number; total: number }) => void
  clearSearch: () => void

  // Highlight bar (navigation mode)
  showHighlightBar: (query: string, results: SearchResult[], initialIndex?: number) => void
  hideHighlightBar: () => void
  navigateToResultIndex: (index: number) => void
  goToPreviousResult: () => void
  goToNextResult: () => void
}

export const useSearchStore = create<SearchState>((set, get) => ({
  // ===== Initial state =====
  // Search panel
  isSearchOpen: false,
  searchScope: 'global',
  query: '',
  searchedQuery: '',
  results: null, // null = not searched yet
  isSearching: false,
  progress: { current: 0, total: 0 },

  // Highlight bar
  isHighlightBarVisible: false,
  currentResultIndex: 0,
  highlightQuery: '',
  highlightResults: [],

  // ===== Search Panel Actions (Edit Mode) =====
  /**
   * Open search panel without clearing previous search state
   * This preserves query and results when user opens search from highlight bar
   */
  openSearch: (scope = 'global') =>
    set({
      isSearchOpen: true,
      searchScope: scope
      // Note: DO NOT clear results/query here - preserve state for user to resume
    }),

  closeSearch: () =>
    set({
      isSearchOpen: false
    }),

  /**
   * Reset search completely (clear query, results, progress)
   * Use when user manually clicks to start a new search, or changes search scope
   */
  resetSearch: () =>
    set({
      query: '',
      searchedQuery: '',
      results: null,
      isSearching: false,
      progress: { current: 0, total: 0 }
    }),

  setQuery: (query) => set({ query }),

  setScope: (scope) => set({ searchScope: scope }),

  setResults: (results) => set({ results }),

  setSearchedQuery: (query) => set({ searchedQuery: query }),

  setIsSearching: (isSearching) => set({ isSearching }),

  setProgress: (progress) => set({ progress }),

  clearSearch: () =>
    set({
      query: '',
      searchedQuery: '',
      results: null,
      isSearching: false,
      progress: { current: 0, total: 0 }
    }),

  // ===== Highlight Bar Actions (Navigation Mode) =====
  /**
   * Show highlight bar when user clicks a search result
   * Automatically closes search panel and shows navigation bar
   */
  showHighlightBar: (query, results, initialIndex = 0) => {
    console.log(`[SearchStore] Showing highlight bar: query="${query}", ${results.length} results`)
    set({
      isSearchOpen: false,
      isHighlightBarVisible: true,
      highlightQuery: query,
      highlightResults: results,
      currentResultIndex: Math.max(0, Math.min(initialIndex, results.length - 1))
    })
  },

  /**
   * Hide highlight bar when user clicks close or presses Esc
   * Also clears page highlights by dispatching event
   */
  hideHighlightBar: () => {
    console.log(`[SearchStore] Hiding highlight bar and clearing highlights`)
    set({
      isHighlightBarVisible: false,
      currentResultIndex: 0,
      highlightQuery: '',
      highlightResults: []
    })
    // Dispatch event to clear visual highlights from the page
    window.dispatchEvent(new CustomEvent('search:clear-highlights'))
  },

  /**
   * Navigate to a specific result by index (0-based)
   * This is a simple index update - the actual navigation is handled by App component
   */
  navigateToResultIndex: (index) => {
    const { highlightResults } = get()
    if (highlightResults.length === 0) return

    const validIndex = Math.max(0, Math.min(index, highlightResults.length - 1))
    console.log(`[SearchStore] Navigating to result ${validIndex + 1}/${highlightResults.length}`)

    set({ currentResultIndex: validIndex })

    // Dispatch navigation event - App component will handle the full navigation flow
    const result = highlightResults[validIndex]
    const event = new CustomEvent('search:navigate-to-result', {
      detail: {
        messageId: result.messageId,
        spaceId: result.spaceId,
        conversationId: result.conversationId,
        query: get().highlightQuery,
        resultIndex: validIndex
      }
    })
    console.log(`[SearchStore] Dispatching search:navigate-to-result event`, event.detail)
    window.dispatchEvent(event)
  },

  /**
   * Navigate to previous result (with circular behavior)
   */
  goToPreviousResult: () => {
    const { currentResultIndex, highlightResults } = get()
    if (highlightResults.length === 0) return

    // Circular: if at 0, go to last
    const nextIndex = currentResultIndex === 0 ? highlightResults.length - 1 : currentResultIndex - 1
    get().navigateToResultIndex(nextIndex)
  },

  /**
   * Navigate to next result (with circular behavior)
   */
  goToNextResult: () => {
    const { currentResultIndex, highlightResults } = get()
    if (highlightResults.length === 0) return

    // Circular: if at last, go to 0
    const nextIndex = currentResultIndex === highlightResults.length - 1 ? 0 : currentResultIndex + 1
    get().navigateToResultIndex(nextIndex)
  }
}))
