/**
 * Search Highlight Bar - Floating navigation bar for search results
 *
 * Appears when user clicks a search result
 * Allows navigation between results within current conversation only
 *
 * Features:
 * - Display current position within current conversation (e.g., "2/5")
 * - Previous/next result navigation (limited to current conversation)
 * - Return to search panel to edit query
 * - Close and clear highlights
 */

import { useRef, useMemo } from 'react'
import { ChevronUp, ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSearchStore } from '@/stores/search.store'
import { useChatStore } from '@/stores/chat.store'

export function SearchHighlightBar() {
  const {
    isHighlightBarVisible,
    highlightQuery,
    highlightResults,
    currentResultIndex,
    navigateToResultIndex,
    hideHighlightBar,
    openSearch
  } = useSearchStore()

  const { currentConversationId } = useChatStore()

  // Debounce timer for navigation to prevent rapid switches
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const pendingNavigationRef = useRef<(() => void) | null>(null)

  /**
   * Debounced navigation handler
   * If user clicks multiple times rapidly, only executes the last click after 300ms of inactivity
   */
  const debouncedNavigate = (callback: () => void) => {
    // Clear previous timeout
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // Store the pending navigation
    pendingNavigationRef.current = callback

    // Set new timeout
    debounceTimerRef.current = setTimeout(() => {
      console.log('[SearchHighlightBar] Executing debounced navigation')
      pendingNavigationRef.current?.()
      pendingNavigationRef.current = null
      debounceTimerRef.current = null
    }, 300) // 300ms debounce window
  }

  // Filter results to current conversation only (if we have a current conversation)
  // Falls back to showing all results if no conversation is selected
  const currentConversationResults = useMemo(() => {
    const mapped = highlightResults.map((result, originalIndex) => ({ result, originalIndex }))
    if (!currentConversationId) {
      // No conversation selected, show all results
      return mapped
    }
    const filtered = mapped.filter(({ result }) => result.conversationId === currentConversationId)
    // If no results in current conversation, show all results as fallback
    return filtered.length > 0 ? filtered : mapped
  }, [highlightResults, currentConversationId])

  // Find current position within filtered results
  const currentFilteredIndex = useMemo(() => {
    return currentConversationResults.findIndex(
      ({ originalIndex }) => originalIndex === currentResultIndex
    )
  }, [currentConversationResults, currentResultIndex])

  if (!isHighlightBarVisible || currentConversationResults.length === 0) {
    return null
  }

  const totalResults = currentConversationResults.length
  const displayIndex = Math.max(1, currentFilteredIndex + 1) // 1-based display

  // Determine if navigation buttons should be disabled
  const canNavigate = totalResults > 1

  const handleEditSearch = () => {
    openSearch()
  }

  const handleClose = () => {
    hideHighlightBar()
  }

  // Navigate to earlier result (higher index in time-sorted results)
  // ↑ button goes to earlier/older results
  const handlePrevious = () => {
    if (canNavigate) {
      debouncedNavigate(() => {
        const nextFilteredIndex = currentFilteredIndex + 1 >= totalResults ? 0 : currentFilteredIndex + 1
        const { originalIndex } = currentConversationResults[nextFilteredIndex]
        console.log(`[SearchHighlightBar] Navigate to earlier result: ${nextFilteredIndex + 1}/${totalResults}`)
        navigateToResultIndex(originalIndex)
      })
    }
  }

  // Navigate to more recent result (lower index in time-sorted results)
  // ↓ button goes to newer/more recent results
  const handleNext = () => {
    if (canNavigate) {
      debouncedNavigate(() => {
        const nextFilteredIndex = currentFilteredIndex - 1 < 0 ? totalResults - 1 : currentFilteredIndex - 1
        const { originalIndex } = currentConversationResults[nextFilteredIndex]
        console.log(`[SearchHighlightBar] Navigate to more recent result: ${nextFilteredIndex + 1}/${totalResults}`)
        navigateToResultIndex(originalIndex)
      })
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-40">
      {/* Main bar container */}
      <div className="bg-background border border-border rounded-lg shadow-lg overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 whitespace-nowrap">
          {/* Query display */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-foreground truncate">
              "{highlightQuery}"
            </span>
          </div>

          {/* Separator */}
          <div className="w-px h-5 bg-border" />

          {/* Position display */}
          <div className="text-xs text-muted-foreground font-medium">
            {displayIndex}/{totalResults}
          </div>

          {/* Navigation buttons */}
          <div className="flex items-center gap-1">
            <button
              onClick={handlePrevious}
              disabled={!canNavigate}
              className={cn(
                'p-1.5 rounded transition-colors',
                canNavigate
                  ? 'hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer'
                  : 'text-muted-foreground/40 cursor-not-allowed'
              )}
              title="Earlier result (↑)"
              aria-label="Earlier result"
            >
              <ChevronUp size={16} />
            </button>

            <button
              onClick={handleNext}
              disabled={!canNavigate}
              className={cn(
                'p-1.5 rounded transition-colors',
                canNavigate
                  ? 'hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer'
                  : 'text-muted-foreground/40 cursor-not-allowed'
              )}
              title="More recent result (↓)"
              aria-label="More recent result"
            >
              <ChevronDown size={16} />
            </button>
          </div>

          {/* Separator */}
          <div className="w-px h-5 bg-border" />

          {/* Action buttons */}
          <div className="flex items-center gap-1">
            <button
              onClick={handleEditSearch}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="Edit search (Ctrl+K)"
              aria-label="Edit search"
            >
              <Search size={16} />
            </button>

            <button
              onClick={handleClose}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="Close (Esc)"
              aria-label="Close search"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Hint text with background to prevent overlap */}
      <div className="mt-2 text-xs text-muted-foreground text-right">
        <span className="bg-background/95 backdrop-blur-sm px-2 py-1 rounded border border-border/50">
          ↑↓ Navigate · Ctrl+K Edit · Esc Close
        </span>
      </div>
    </div>
  )
}
