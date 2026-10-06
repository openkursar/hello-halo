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
 * - Keys: ↑/↓ step like the buttons, Esc closes, Ctrl/⌘+K edits (highlight-bar-keys)
 */

import { useEffect, useRef, useMemo } from 'react'
import { ChevronUp, ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { conversationResults, useSearchStore, type ResultStep } from '@/stores/search.store'
import { useChatStore, selectActiveConversationId } from '@/stores/chat.store'
import { useTranslation } from '@/i18n'
import { highlightBarCommand } from './highlight-bar-keys'

const isMac = typeof navigator !== 'undefined' &&
  navigator.platform.toUpperCase().indexOf('MAC') >= 0
const EDIT_SHORTCUT = isMac ? '⌘K' : 'Ctrl+K'

export function SearchHighlightBar() {
  const { t } = useTranslation()
  const {
    isHighlightBarVisible,
    highlightQuery,
    highlightResults,
    currentResultIndex,
    stepResult,
    hideHighlightBar,
    openSearch
  } = useSearchStore()

  // The conversation on screen — a selected digital human's, else the regular
  // one — decides which results count as "in this conversation".
  const currentConversationId = useChatStore(selectActiveConversationId)

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
      pendingNavigationRef.current?.()
      pendingNavigationRef.current = null
      debounceTimerRef.current = null
    }, 300) // 300ms debounce window
  }

  const currentConversationResults = useMemo(
    () => conversationResults(highlightResults, currentConversationId),
    [highlightResults, currentConversationId]
  )

  // Find current position within filtered results
  const currentFilteredIndex = useMemo(() => {
    return currentConversationResults.findIndex(
      ({ originalIndex }) => originalIndex === currentResultIndex
    )
  }, [currentConversationResults, currentResultIndex])

  const totalResults = currentConversationResults.length

  // Determine if navigation buttons should be disabled
  const canNavigate = totalResults > 1

  // ↑ goes to earlier results, ↓ to more recent ones
  const step = (direction: ResultStep) => {
    if (canNavigate) debouncedNavigate(() => stepResult(direction, currentConversationId))
  }
  const latestStep = useRef(step)
  latestStep.current = step

  useEffect(() => {
    if (!isHighlightBarVisible) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const command = highlightBarCommand(e, isMac)
      if (!command) return
      e.preventDefault()
      if (command === 'close') hideHighlightBar()
      else if (command === 'edit') openSearch('global', 'shortcut')
      else latestStep.current(command)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isHighlightBarVisible, hideHighlightBar, openSearch])

  if (!isHighlightBarVisible || currentConversationResults.length === 0) {
    return null
  }

  const displayIndex = Math.max(1, currentFilteredIndex + 1) // 1-based display

  const handleEditSearch = () => {
    openSearch('global', 'highlight_bar')
  }

  const handleClose = () => {
    hideHighlightBar()
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
              onClick={() => step('earlier')}
              disabled={!canNavigate}
              className={cn(
                'p-1.5 rounded transition-colors',
                canNavigate
                  ? 'hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer'
                  : 'text-muted-foreground/40 cursor-not-allowed'
              )}
              title={t('Earlier result (↑)')}
              aria-label={t('Earlier result')}
            >
              <ChevronUp size={16} />
            </button>

            <button
              onClick={() => step('more-recent')}
              disabled={!canNavigate}
              className={cn(
                'p-1.5 rounded transition-colors',
                canNavigate
                  ? 'hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer'
                  : 'text-muted-foreground/40 cursor-not-allowed'
              )}
              title={t('More recent result (↓)')}
              aria-label={t('More recent result')}
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
              title={t('Edit search ({{shortcut}})', { shortcut: EDIT_SHORTCUT })}
              aria-label={t('Edit search')}
            >
              <Search size={16} />
            </button>

            <button
              onClick={handleClose}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={t('Close (Esc)')}
              aria-label={t('Close search')}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Hint text with background to prevent overlap */}
      <div className="mt-2 text-xs text-muted-foreground text-right">
        <span className="bg-background/95 backdrop-blur-sm px-2 py-1 rounded border border-border/50">
          {t('↑↓ Navigate · {{shortcut}} Edit · Esc Close', { shortcut: EDIT_SHORTCUT })}
        </span>
      </div>
    </div>
  )
}
