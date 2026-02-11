/**
 * Search Panel Component
 *
 * Main search interface with three scopes:
 * - conversation: Search within current conversation
 * - space: Search within current space
 * - global: Search across all spaces
 *
 * Features:
 * - Real-time progress tracking
 * - Searchable result list with context preview
 * - Keyboard shortcuts (Esc to close)
 * - Click result to open conversation and scroll to message
 */

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/api'
import { useChatStore } from '@/stores/chat.store'
import { useSpaceStore } from '@/stores/space.store'
import { useSearchStore } from '@/stores/search.store'
import { useTranslation } from '@/i18n'

export type SearchScope = 'conversation' | 'space' | 'global'

interface SearchResultItem {
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

interface SearchPanelProps {
  isOpen: boolean
  onClose: () => void
}

export function SearchPanel({ isOpen, onClose }: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()

  const { currentSpaceId, currentConversationId, selectConversation, setCurrentSpace, loadConversations } = useChatStore()
  const { spaces, haloSpace, setCurrentSpace: setSpaceStoreCurrentSpace } = useSpaceStore()

  // Use search store for state management
  const {
    query,
    searchedQuery,
    searchScope,
    results,
    isSearching,
    progress,
    setQuery,
    setSearchedQuery,
    setScope,
    setResults,
    setIsSearching,
    setProgress,
    showHighlightBar
  } = useSearchStore()

  // Listen for progress updates
  useEffect(() => {
    if (!isOpen) return

    const unsubscribe = api.onSearchProgress((data: unknown) => {
      const progressData = data as { current: number; total: number; searchId: string }
      setProgress({ current: progressData.current, total: progressData.total })
    })

    return unsubscribe
  }, [isOpen])

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure DOM is ready
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [isOpen])

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const handleSearch = async () => {
    if (!query.trim()) {
      return
    }

    setIsSearching(true)
    setProgress({ current: 0, total: 0 })
    setResults([])
    setSearchedQuery(query) // Capture the query at search time

    try {
      // Determine actual scope and IDs based on user selection and current context
      let actualScope = searchScope
      let actualConvId: string | undefined
      let actualSpaceId: string | undefined

      switch (searchScope) {
        case 'conversation':
          // Only search current conversation if we have one
          if (currentConversationId && currentSpaceId) {
            actualConvId = currentConversationId
            actualSpaceId = currentSpaceId
            // Keep conversation scope
          } else if (currentSpaceId) {
            // Fall back to space search
            actualScope = 'space'
            actualSpaceId = currentSpaceId
          } else {
            // Fall back to global
            actualScope = 'global'
          }
          break

        case 'space':
          // Only search current space if we have one
          if (currentSpaceId) {
            actualSpaceId = currentSpaceId
            // Keep space scope
          } else {
            // Fall back to global
            actualScope = 'global'
          }
          break

        case 'global':
          // Global search, no IDs needed
          actualScope = 'global'
          break
      }

      console.log('[Search] Executing:', { scope: actualScope, spaceId: actualSpaceId, conversationId: actualConvId })

      const response = await api.search(query, actualScope, actualConvId, actualSpaceId)

      if (response.success && response.data) {
        const results = response.data as SearchResultItem[]
        setResults(results)
        console.log(`[Search] Found ${results.length} results in ${actualScope} scope`)
      } else {
        console.error('[Search] Error:', response.error)
      }
    } catch (error) {
      console.error('[Search] Exception:', error)
    } finally {
      setIsSearching(false)
    }
  }

  const handleResultClick = async (result: SearchResultItem) => {
    console.log(`[Search] Clicking result: conv=${result.conversationId}, space=${result.spaceId}, msg=${result.messageId}`)

    try {
      // Step 1: If switching spaces, update BOTH stores to keep UI and chat state in sync
      if (result.spaceId !== currentSpaceId) {
        console.log(`[Search] Switching to space: ${result.spaceId}`)

        // Find the space object
        let targetSpace = null
        if (result.spaceId === 'halo-temp' && haloSpace) {
          targetSpace = haloSpace
        } else {
          targetSpace = spaces.find(s => s.id === result.spaceId)
        }

        if (!targetSpace) {
          console.error(`[Search] Space not found: ${result.spaceId}`)
          return
        }

        // Update spaceStore (this will trigger UI updates)
        console.log(`[Search] Updating spaceStore.currentSpace to: ${targetSpace.name}`)
        setSpaceStoreCurrentSpace(targetSpace)

        // Update chatStore currentSpaceId
        console.log(`[Search] Updating chatStore.currentSpaceId to: ${result.spaceId}`)
        setCurrentSpace(result.spaceId)

        // Give state time to update
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      // Step 2: Load conversations in the target space
      console.log(`[Search] Loading conversations in space: ${result.spaceId}`)
      await loadConversations(result.spaceId)
      console.log(`[Search] Conversations loaded`)

      // Step 3: Navigate to conversation
      console.log(`[Search] Selecting conversation: ${result.conversationId}`)
      await selectConversation(result.conversationId)
      console.log(`[Search] Conversation selected`)

      // Step 4: Show highlight bar with all results (enable navigation)
      const resultsArray = results ?? []
      console.log(`[Search] Showing highlight bar with ${resultsArray.length} results`)
      showHighlightBar(searchedQuery, resultsArray, resultsArray.findIndex(r => r.messageId === result.messageId))

      // Close search panel
      onClose()

      // Step 5: Dispatch navigation event for ChatView to handle
      // ChatView uses Virtuoso scrollToIndex to bring the message into viewport,
      // then applies DOM highlighting — no need to pre-check DOM existence here.
      // Small delay to let conversation data load and MessageList mount.
      setTimeout(() => {
        console.log(`[Search] Dispatching navigate-to-message for: ${result.messageId}`)
        const event = new CustomEvent('search:navigate-to-message', {
          detail: {
            messageId: result.messageId,
            query: searchedQuery
          }
        })
        window.dispatchEvent(event)
      }, 300)
    } catch (error) {
      console.error(`[Search] Error navigating to result:`, error)
    }
  }

  const handleCancel = async () => {
    await api.cancelSearch()
    setIsSearching(false)
  }

  if (!isOpen) {
    return null
  }

  const scopeLabels = {
    conversation: t('Current conversation'),
    space: t('Current space'),
    global: t('All spaces')
  }

  const scopeDescriptions = {
    conversation: t('Current conversation'),
    space: t('Current space'),
    global: t('All spaces')
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background border border-border rounded-lg shadow-lg w-full max-w-3xl max-h-[80vh] flex flex-col">
        {/* Search Input */}
        <div className="flex items-center border-b border-border p-4 gap-3">
          <span className="text-lg text-muted-foreground">🔍</span>
          <input
            ref={inputRef}
            type="text"
            placeholder={t('Search...')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSearch()
              }
            }}
            className="flex-1 bg-transparent outline-none text-foreground text-sm"
          />
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close search"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scope Tabs */}
        <div className="flex border-b border-border px-4 pt-2">
          {(['conversation', 'space', 'global'] as SearchScope[]).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={cn(
                'px-4 py-2 border-b-2 text-sm transition-colors',
                searchScope === s
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {scopeLabels[s]}
            </button>
          ))}
        </div>

        {/* Results or Loading State */}
        <div className="flex-1 overflow-y-auto p-4">
          {isSearching ? (
            <div className="text-center py-8">
              <div className="mb-4 text-sm">📋 {t('Searching {{scope}}...', { scope: scopeDescriptions[searchScope] })}</div>
              <div className="text-xs text-muted-foreground mb-4">
                {t('Scanned {{current}} / {{total}} conversations', { current: progress.current, total: progress.total })}
              </div>
              <div className="w-full bg-border rounded-full h-2 mb-4">
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{
                    width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%`
                  }}
                />
              </div>
              <button
                onClick={handleCancel}
                className="px-3 py-1 text-xs border border-border rounded hover:bg-muted transition-colors"
              >
                {t('Cancel search')}
              </button>
            </div>
          ) : results !== null && results.length > 0 ? (
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">
                💬 {t('Found {{count}} results', { count: results.length })}
              </div>
              {results.map((result, idx) => (
                <button
                  key={idx}
                  onClick={() => handleResultClick(result)}
                  className="w-full text-left p-3 border border-border rounded hover:bg-muted/50 transition-colors text-sm"
                >
                  {/* Result Header - Space, Conversation, Time */}
                  <div className="flex items-start justify-between mb-2 gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground flex-shrink-0">
                          {result.spaceName}
                        </span>
                        <span className="font-medium text-xs truncate">
                          {result.conversationTitle}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {new Date(result.messageTimestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} {new Date(result.messageTimestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    {/* Role badge */}
                    <span className="text-xs px-2 py-1 rounded bg-primary/10 text-primary flex-shrink-0">
                      {result.messageRole === 'user' ? t('You') : 'AI'}
                    </span>
                  </div>

                  {/* Highlighted Context - showing where the match is */}
                  <div className="text-sm text-foreground bg-muted/30 p-2 rounded mt-2 border-l-2 border-primary/50">
                    <span className="text-muted-foreground">{result.contextBefore}</span>
                    <span className="bg-yellow-500/30 font-semibold px-0.5 py-0 rounded">{searchedQuery}</span>
                    <span className="text-muted-foreground">{result.contextAfter}</span>
                  </div>

                  {/* Show if there are multiple matches */}
                  {result.matchCount > 1 && (
                    <div className="text-xs text-muted-foreground mt-1">
                      ↳ {t('{{count}} matches in this message', { count: result.matchCount })}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : results !== null && results.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-sm text-muted-foreground">{t('No matching results found')}</div>
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="text-sm text-muted-foreground">{t('Enter search content, press Enter to search')}</div>
            </div>
          )}
        </div>

        {/* Footer Help */}
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground text-center">
          {t('Press Esc to close · Enter to search')}
        </div>
      </div>
    </div>
  )
}
