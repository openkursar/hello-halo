/**
 * Search Panel — global command palette, prototype `#cmdk`.
 *
 * Two layers coexist here, matching the two real capabilities this app has
 * (the prototype only ever modeled the first one — its CMDK_ITEMS are a
 * static demo list, title-match only, no real full-text search):
 *
 * - Quick jump: instant, as-you-type title/name matching across
 *   conversations (current space), tasks, digital humans, and knowledge
 *   bases — click a row, it opens immediately. Matches the prototype's
 *   grouped-by-type results and its empty-query "quick actions + recent"
 *   view exactly.
 * - Message content search: the existing async full-text search across
 *   message bodies (not just titles), scoped to conversation/space/global,
 *   with a progress bar and cancel — kept as-is, just triggered explicitly
 *   now (via Enter / clicking the "search message content" row) instead of
 *   being the panel's only mode.
 *
 * Typing always shows the quick-jump layer first; running a message-content
 * search swaps the body to the existing results UI until the query changes
 * again.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Search, Loader2, MessageSquare, CornerDownRight, ChevronDown, Check,
  SquarePen, Bot, FolderKanban, BookOpen, Settings, SquareCheckBig
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/api'
import { useChatStore } from '@/stores/chat.store'
import { useSpaceStore } from '@/stores/space.store'
import { useAppStore } from '@/stores/app.store'
import { useAppsPageStore } from '@/stores/apps-page.store'
import { useTlonStore } from '@/stores/tlon.store'
import { useSearchStore } from '@/stores/search.store'
import { useTranslation } from '@/i18n'
import { useQuickJumpCandidates, type QuickJumpItem, type QuickJumpType } from './useQuickJumpCandidates'

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

const TYPE_ICON: Record<QuickJumpType, typeof MessageSquare> = {
  conv: MessageSquare,
  agent: Bot,
  task: SquareCheckBig,
  kb: BookOpen,
}

// Group + render order matches the prototype's renderCmdk() type loop.
const GROUP_ORDER: QuickJumpType[] = ['conv', 'agent', 'task', 'kb']

export function SearchPanel({ isOpen, onClose }: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()
  const { navigate } = useAppStore()

  const { currentSpaceId, selectConversation, setCurrentSpace, loadConversations, createConversation, spaceStates } = useChatStore()
  // currentConversationId lives per-space in spaceStates, not at the store's
  // top level — the pre-existing destructure here read a field that doesn't
  // exist on ChatState (always undefined, silently degrading conversation
  // scope to space scope).
  const currentConversationId = currentSpaceId ? spaceStates.get(currentSpaceId)?.currentConversationId ?? null : null
  const { spaces, haloSpace, setCurrentSpace: setSpaceStoreCurrentSpace } = useSpaceStore()

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

  const candidates = useQuickJumpCandidates()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)

  // A message-content search has been run for the query currently in the
  // box — show its results/progress instead of the quick-jump layer.
  const showDeepSearch = isSearching || results !== null

  useEffect(() => {
    if (!isOpen) return
    const unsubscribe = api.onSearchProgress((data: unknown) => {
      const progressData = data as { current: number; total: number; searchId: string }
      setProgress({ current: progressData.current, total: progressData.total })
    })
    return unsubscribe
  }, [isOpen])

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 30)
  }, [isOpen])

  // Esc closes. ⌘K's toggle-closed behavior lives centrally in
  // useSearchShortcuts (see its comment) so there's exactly one place
  // deciding open-vs-close instead of two listeners racing each other.
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const recentConversations = useMemo(() => {
    return candidates
      .filter(c => c.type === 'conv')
      .slice()
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
      .slice(0, 5)
  }, [candidates])

  const quickHits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return candidates.filter(c => c.title.toLowerCase().includes(q))
  }, [candidates, query])

  const openQuickJumpItem = async (item: QuickJumpItem) => {
    if (item.type === 'agent' && item.appId) {
      navigate('apps')
      useAppsPageStore.getState().selectApp(item.appId)
      onClose()
      return
    }
    if (item.type === 'kb' && item.kbId) {
      navigate('tlon')
      useTlonStore.getState().selectKB(item.kbId)
      onClose()
      return
    }
    if ((item.type === 'conv' || item.type === 'task') && item.conversationId && item.spaceId) {
      if (item.spaceId !== currentSpaceId) {
        const targetSpace = item.spaceId === 'halo-temp' && haloSpace ? haloSpace : spaces.find(s => s.id === item.spaceId)
        if (!targetSpace) return
        setSpaceStoreCurrentSpace(targetSpace)
        setCurrentSpace(item.spaceId)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      await loadConversations(item.spaceId)
      await selectConversation(item.conversationId)
      onClose()
    }
  }

  const runNewConversation = async () => {
    navigate('space')
    if (currentSpaceId) await createConversation(currentSpaceId)
    onClose()
  }
  const runNewAgent = () => { navigate('apps'); onClose() }
  const runSwitchSpace = () => {
    navigate('space')
    onClose()
    // Delay lets SpacePage (and SpaceSelector within it) finish mounting if
    // we just navigated here from a different page — matches the delay
    // handleResultClick already uses for the same reason.
    setTimeout(() => window.dispatchEvent(new CustomEvent('space-selector:open')), 300)
  }
  const runOpenKnowledgeBase = () => { navigate('tlon'); onClose() }
  const runOpenSettings = () => { navigate('settings'); onClose() }

  const quickActions = useMemo(() => [
    { key: 'action:new-conv', icon: SquarePen, label: t('New Conversation'), run: runNewConversation },
    { key: 'action:new-agent', icon: Bot, label: t('New Digital Human'), run: runNewAgent },
    { key: 'action:switch-space', icon: FolderKanban, label: t('Switch Workspace'), run: runSwitchSpace },
    { key: 'action:open-kb', icon: BookOpen, label: t('Open Knowledge Base'), run: runOpenKnowledgeBase },
    { key: 'action:open-settings', icon: Settings, label: t('Open Settings'), run: runOpenSettings },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [currentSpaceId, t])

  const handleSearch = async () => {
    if (!query.trim()) return
    setIsSearching(true)
    setProgress({ current: 0, total: 0 })
    setResults([])
    setSearchedQuery(query)

    try {
      let actualScope = searchScope
      let actualConvId: string | undefined
      let actualSpaceId: string | undefined

      switch (searchScope) {
        case 'conversation':
          if (currentConversationId && currentSpaceId) {
            actualConvId = currentConversationId
            actualSpaceId = currentSpaceId
          } else if (currentSpaceId) {
            actualScope = 'space'
            actualSpaceId = currentSpaceId
          } else {
            actualScope = 'global'
          }
          break
        case 'space':
          if (currentSpaceId) {
            actualSpaceId = currentSpaceId
          } else {
            actualScope = 'global'
          }
          break
        case 'global':
          actualScope = 'global'
          break
      }

      const response = await api.search(query, actualScope, actualConvId, actualSpaceId)
      if (response.success && response.data) {
        setResults(response.data as SearchResultItem[])
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
    try {
      if (result.spaceId !== currentSpaceId) {
        const targetSpace = result.spaceId === 'halo-temp' && haloSpace ? haloSpace : spaces.find(s => s.id === result.spaceId)
        if (!targetSpace) return
        setSpaceStoreCurrentSpace(targetSpace)
        setCurrentSpace(result.spaceId)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      await loadConversations(result.spaceId)
      await selectConversation(result.conversationId)

      const resultsArray = results ?? []
      showHighlightBar(searchedQuery, resultsArray, resultsArray.findIndex(r => r.messageId === result.messageId))
      onClose()

      setTimeout(() => {
        const event = new CustomEvent('search:navigate-to-message', {
          detail: { messageId: result.messageId, query: searchedQuery }
        })
        window.dispatchEvent(event)
      }, 300)
    } catch (error) {
      console.error('[Search] Error navigating to result:', error)
    }
  }

  const handleCancel = async () => {
    await api.cancelSearch()
    setIsSearching(false)
  }

  // Flat, keyboard-navigable row list for the quick-jump layer (empty-query
  // actions+recent, or title-match hits+the "search in messages" row).
  // Deep-search results are mouse/Esc only, same as before this pass.
  const rows = useMemo(() => {
    if (showDeepSearch) return []
    if (!query.trim()) {
      return [
        ...quickActions.map(a => ({ key: a.key, onActivate: a.run })),
        ...recentConversations.map(c => ({ key: c.key, onActivate: () => openQuickJumpItem(c) })),
      ]
    }
    return [
      ...quickHits.map(h => ({ key: h.key, onActivate: () => openQuickJumpItem(h) })),
      { key: 'action:search-messages', onActivate: handleSearch },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeepSearch, query, quickActions, recentConversations, quickHits])

  useEffect(() => { setSelectedIndex(0) }, [query, showDeepSearch])

  const handleQueryChange = (value: string) => {
    setQuery(value)
    // A fresh keystroke always drops back to the quick-jump layer — without
    // this, editing the box after a message-content search keeps showing
    // stale results for a query that no longer matches the input.
    if (results !== null) setResults(null)
  }

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (scopeMenuOpen) return
    if (e.key === 'ArrowDown') {
      if (!rows.length) return
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      if (!rows.length) return
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (rows.length) rows[selectedIndex]?.onActivate()
      else handleSearch()
    }
  }

  if (!isOpen) return null

  const scopeLabels: Record<SearchScope, string> = {
    conversation: t('Current conversation'),
    space: t('Current workspace'),
    global: t('All workspaces')
  }
  const scopeDescriptions = scopeLabels

  return (
    <>
      <div className="fixed inset-0 z-[100] bg-black/40" onClick={onClose} />
      <div className="fixed left-1/2 top-[11%] -translate-x-1/2 z-[101] w-[min(640px,92vw)] max-h-[72vh] bg-card border border-border rounded-2xl shadow-pop flex flex-col overflow-hidden">
        {/* Top bar: icon + input + scope pill */}
        <div className="flex-shrink-0 flex items-center gap-2.5 px-[14px] py-3 border-b border-border">
          <Search className="w-[18px] h-[18px] text-subtle-foreground flex-shrink-0" strokeWidth={1.8} />
          <input
            ref={inputRef}
            type="text"
            placeholder={t('Search conversations, files, tasks, knowledge bases, digital humans, or run an action...')}
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleInputKeyDown}
            className="flex-1 min-w-0 bg-transparent outline-none text-foreground text-[15px]"
          />
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setScopeMenuOpen(v => !v)}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border bg-secondary text-muted-foreground text-xs hover:border-primary transition-colors ease-halo"
            >
              {scopeLabels[searchScope]}
              <ChevronDown className="w-2.5 h-2.5 text-subtle-foreground" />
            </button>
            {scopeMenuOpen && (
              <div className="absolute right-0 top-[34px] w-[150px] p-[5px] rounded-md border border-border bg-card shadow-pop z-10">
                {(['conversation', 'space', 'global'] as SearchScope[]).map(s => (
                  <button
                    key={s}
                    onClick={() => { setScope(s); setScopeMenuOpen(false) }}
                    className={cn(
                      'w-full flex items-center gap-2 px-[9px] py-[7px] rounded text-xs transition-colors ease-halo hover:bg-secondary',
                      searchScope === s ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {scopeLabels[s]}
                    {searchScope === s && <Check className="w-3 h-3 text-primary ml-auto" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-2">
          {showDeepSearch ? (
            isSearching ? (
              <div className="text-center py-8">
                <div className="mb-4 flex items-center justify-center gap-2 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin text-subtle-foreground" />
                  {t('Searching {{scope}}...', { scope: scopeDescriptions[searchScope] })}
                </div>
                <div className="text-xs text-muted-foreground mb-4">
                  {t('Scanned {{current}} / {{total}} conversations', { current: progress.current, total: progress.total })}
                </div>
                <div className="w-full bg-border rounded-full h-2 mb-4">
                  <div
                    className="bg-primary h-2 rounded-full transition-all"
                    style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                  />
                </div>
                <button
                  onClick={handleCancel}
                  className="px-3 py-1 text-xs border border-border rounded hover:bg-muted transition-colors"
                >
                  {t('Cancel search')}
                </button>
              </div>
            ) : results && results.length > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-2">
                  <MessageSquare className="w-3.5 h-3.5" strokeWidth={1.8} />
                  {t('Found {{count}} results', { count: results.length })}
                </div>
                {results.map((result, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleResultClick(result)}
                    className="w-full text-left p-3 border border-border rounded hover:bg-muted/50 transition-colors text-sm"
                  >
                    <div className="flex items-start justify-between mb-2 gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground flex-shrink-0">
                            {result.spaceName}
                          </span>
                          <span className="font-medium text-xs truncate">{result.conversationTitle}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {new Date(result.messageTimestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} {new Date(result.messageTimestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                      <span className="text-xs px-2 py-1 rounded bg-primary/10 text-primary flex-shrink-0">
                        {result.messageRole === 'user' ? t('You') : 'AI'}
                      </span>
                    </div>
                    <div className="text-sm text-foreground bg-muted/30 p-2 rounded mt-2 border-l-2 border-primary/50">
                      <span className="text-muted-foreground">{result.contextBefore}</span>
                      <span className="bg-yellow-500/30 font-semibold px-0.5 py-0 rounded">{searchedQuery}</span>
                      <span className="text-muted-foreground">{result.contextAfter}</span>
                    </div>
                    {result.matchCount > 1 && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                        <CornerDownRight className="w-3 h-3" strokeWidth={1.8} />
                        {t('{{count}} matches in this message', { count: result.matchCount })}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-sm text-muted-foreground">{t('No matching results found')}</div>
            )
          ) : !query.trim() ? (
            <>
              <div className="px-[10px] pt-[10px] pb-1 flex items-center justify-between text-[11px] font-semibold text-subtle-foreground">
                {t('Quick actions')}
              </div>
              {quickActions.map((action, i) => (
                <CmdkRow
                  key={action.key}
                  icon={action.icon}
                  title={action.label}
                  selected={i === selectedIndex}
                  onClick={action.run}
                  onMouseMove={() => setSelectedIndex(i)}
                />
              ))}
              {recentConversations.length > 0 && (
                <>
                  <div className="px-[10px] pt-[10px] pb-1 flex items-center justify-between text-[11px] font-semibold text-subtle-foreground">
                    {t('Recent')}
                  </div>
                  {recentConversations.map((item, i) => {
                    const idx = quickActions.length + i
                    return (
                      <CmdkRow
                        key={item.key}
                        icon={TYPE_ICON[item.type]}
                        title={item.title}
                        meta={item.meta}
                        selected={idx === selectedIndex}
                        onClick={() => openQuickJumpItem(item)}
                        onMouseMove={() => setSelectedIndex(idx)}
                      />
                    )
                  })}
                </>
              )}
            </>
          ) : (
            <>
              {quickHits.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {t('No quick-jump matches — try searching message content below')}
                </div>
              ) : (
                GROUP_ORDER.map(type => {
                  const group = quickHits.filter(h => h.type === type)
                  if (!group.length) return null
                  const typeLabel: Record<QuickJumpType, string> = {
                    conv: t('Conversations'),
                    agent: t('Digital Humans'),
                    task: t('Tasks'),
                    kb: t('Knowledge Bases'),
                  }
                  return (
                    <div key={type}>
                      <div className="px-[10px] pt-[10px] pb-1 flex items-center justify-between text-[11px] font-semibold text-subtle-foreground">
                        {typeLabel[type]}<span>{group.length}</span>
                      </div>
                      {group.map(item => {
                        const idx = quickHits.indexOf(item)
                        return (
                          <CmdkRow
                            key={item.key}
                            icon={TYPE_ICON[item.type]}
                            title={item.title}
                            meta={item.meta}
                            selected={idx === selectedIndex}
                            onClick={() => openQuickJumpItem(item)}
                            onMouseMove={() => setSelectedIndex(idx)}
                          />
                        )
                      })}
                    </div>
                  )
                })
              )}
              <div className="mt-1 pt-1 border-t border-border/50">
                <CmdkRow
                  icon={Search}
                  title={t('Search message content for "{{query}}"', { query })}
                  selected={quickHits.length === selectedIndex}
                  onClick={handleSearch}
                  onMouseMove={() => setSelectedIndex(quickHits.length)}
                />
              </div>
            </>
          )}
        </div>

        {/* Footer — keyboard hints, prototype `.cmdk-foot` */}
        <div className="flex-shrink-0 flex items-center gap-4 px-[14px] py-2 border-t border-border text-[11px] text-subtle-foreground">
          <span><kbd className="border border-border rounded px-1 mr-1">↑↓</kbd>{t('Navigate')}</span>
          <span><kbd className="border border-border rounded px-1 mr-1">↵</kbd>{t('Open')}</span>
          <span><kbd className="border border-border rounded px-1 mr-1">esc</kbd>{t('Close')}</span>
        </div>
      </div>
    </>
  )
}

function CmdkRow({
  icon: Icon,
  title,
  meta,
  selected,
  onClick,
  onMouseMove,
}: {
  icon: typeof MessageSquare
  title: string
  meta?: string
  selected: boolean
  onClick: () => void
  onMouseMove: () => void
}) {
  return (
    <button
      onClick={onClick}
      onMouseMove={onMouseMove}
      className={cn(
        'w-full flex items-center gap-[11px] px-[10px] py-2 rounded-md text-left transition-colors ease-halo',
        selected ? 'bg-secondary' : 'hover:bg-secondary'
      )}
    >
      <span className={cn(
        'w-7 h-7 rounded-sm flex items-center justify-center flex-shrink-0',
        selected ? 'bg-primary/[0.12]' : 'bg-secondary'
      )}>
        <Icon className="w-3.5 h-3.5 text-subtle-foreground" strokeWidth={1.8} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] truncate">{title}</span>
        {meta && <span className="block text-[11px] text-subtle-foreground truncate mt-px">{meta}</span>}
      </span>
    </button>
  )
}
