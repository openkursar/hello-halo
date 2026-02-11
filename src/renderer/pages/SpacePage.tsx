/**
 * Space Page - Chat interface with artifact rail and content canvas
 * Supports multi-conversation with isolated session states per space
 *
 * Layout modes:
 * - Chat mode: Full-width chat view (when no canvas tabs open)
 * - Canvas mode: Split view with narrower chat + content canvas
 * - Mobile mode: Full-screen panels with overlay canvas
 *
 * Layout preferences:
 * - Artifact Rail expansion state (persisted per space)
 * - Chat width when canvas is open (persisted per space)
 * - Maximized mode overrides (temporary)
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../stores/app.store'
import { useSpaceStore } from '../stores/space.store'
import { useChatStore } from '../stores/chat.store'
import { useCanvasStore, useCanvasIsOpen, useCanvasIsMaximized } from '../stores/canvas.store'
import { canvasLifecycle } from '../services/canvas-lifecycle'
import { useSearchStore } from '../stores/search.store'
import { ChatView } from '../components/chat/ChatView'
import { ArtifactRail } from '../components/artifact/ArtifactRail'
import { ConversationList } from '../components/chat/ConversationList'
import { ChatHistoryPanel } from '../components/chat/ChatHistoryPanel'
import { SpaceIcon } from '../components/icons/ToolIcons'
import { Header } from '../components/layout/Header'
import { ModelSelector } from '../components/layout/ModelSelector'
import { ContentCanvas, CanvasToggleButton } from '../components/canvas'
import { GitBashWarningBanner } from '../components/setup/GitBashWarningBanner'
import { api } from '../api'
import { useLayoutPreferences, LAYOUT_DEFAULTS } from '../hooks/useLayoutPreferences'
import { useWindowMaximize } from '../components/canvas/viewers/useWindowMaximize'
import { PanelLeftClose, PanelLeft, X, MessageSquare } from 'lucide-react'
import { SearchIcon } from '../components/search/SearchIcon'
import { PulseBeacon, PulseInlinePanel } from '../components/pulse'
import { useSearchShortcuts } from '../hooks/useSearchShortcuts'
import { usePulseMode } from '../hooks/usePulseMode'
import { useTranslation } from '../i18n'
import { useIsMobile } from '../hooks/useIsMobile'

export function SpacePage() {
  const { t } = useTranslation()
  const { setView, mockBashMode, gitBashInstallProgress, startGitBashInstall } = useAppStore()
  const { currentSpace, refreshCurrentSpace, openSpaceFolder } = useSpaceStore()
  const {
    currentSpaceId,
    setCurrentSpace,
    getConversations,
    getCurrentConversation,
    getCurrentConversationId,
    isLoading,
    loadConversations,
    preloadAllSpaceConversations,
    createConversation,
    selectConversation,
    deleteConversation,
    renameConversation,
    toggleStarConversation
  } = useChatStore()

  // Get current data from store
  const conversations = getConversations()
  const currentConversation = getCurrentConversation()
  const currentConversationId = getCurrentConversationId()

  // Show conversation list for non-temp spaces
  const [showConversationList, setShowConversationList] = useState(false)

  // Canvas state - use precise selectors to minimize re-renders
  const isCanvasOpen = useCanvasIsOpen()
  const isCanvasMaximized = useCanvasIsMaximized()
  const isCanvasTransitioning = useCanvasStore(state => state.isTransitioning)
  const setCanvasOpen = useCanvasStore(state => state.setOpen)
  const setCanvasMaximized = useCanvasStore(state => state.setMaximized)

  // Mobile detection
  const isMobile = useIsMobile()

  // Pulse mode: determines which Pulse form to render
  const pulseMode = usePulseMode({ isConversationListOpen: showConversationList })
  const [pulseCollapsed, setPulseCollapsed] = useState(false)

  // Window maximize state
  const { isMaximized } = useWindowMaximize()

  // Layout preferences (persisted per space)
  const {
    effectiveRailExpanded,
    effectiveChatWidth,
    setRailExpanded,
    setChatWidth,
    chatWidthMin,
    chatWidthMax,
  } = useLayoutPreferences(currentSpace?.id, isMaximized)

  // Chat width drag state
  const [isDraggingChat, setIsDraggingChat] = useState(false)
  const [dragChatWidth, setDragChatWidth] = useState(effectiveChatWidth)
  const chatContainerRef = useRef<HTMLDivElement>(null)

  // Search UI state
  const { openSearch } = useSearchStore()

  // Sync drag width with effective width when not dragging
  useEffect(() => {
    if (!isDraggingChat) {
      setDragChatWidth(effectiveChatWidth)
    }
  }, [effectiveChatWidth, isDraggingChat])

  // Handle chat width drag
  const handleChatDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDraggingChat(true)
  }, [])

  // Chat drag move/end handlers
  useEffect(() => {
    if (!isDraggingChat) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!chatContainerRef.current) return

      // Calculate width from left edge of chat container to mouse position
      const containerRect = chatContainerRef.current.getBoundingClientRect()
      const newWidth = e.clientX - containerRect.left

      // Clamp to constraints
      const clampedWidth = Math.max(chatWidthMin, Math.min(chatWidthMax, newWidth))
      setDragChatWidth(clampedWidth)
    }

    const handleMouseUp = () => {
      setIsDraggingChat(false)
      // Persist the final width
      setChatWidth(dragChatWidth)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDraggingChat, dragChatWidth, chatWidthMin, chatWidthMax, setChatWidth])

  // Close canvas when switching to mobile with canvas open
  useEffect(() => {
    if (isMobile && isCanvasOpen) {
      // Keep canvas open on mobile but we'll show it as overlay
    }
  }, [isMobile, isCanvasOpen])

  // Space isolation: clear canvas tabs when switching to a different space
  useEffect(() => {
    if (currentSpace) {
      canvasLifecycle.enterSpace(currentSpace.id)
    }
  }, [currentSpace?.id])

  // BrowserView visibility: hide when leaving SpacePage, show when returning
  useEffect(() => {
    if (!currentSpace) return

    if (isCanvasOpen) {
      canvasLifecycle.showActiveBrowserView()
    }

    return () => {
      canvasLifecycle.hideAllBrowserViews()
    }
  }, [currentSpace?.id, isCanvasOpen])

  // Initialize space when entering
  useEffect(() => {
    if (!currentSpace) return

    // Set current space in chat store
    setCurrentSpace(currentSpace.id)

    // Load conversations if not already loaded for this space
    const initSpace = async () => {
      await loadConversations(currentSpace.id)

      // Preload other spaces' conversations in background for PULSE global visibility
      const { haloSpace, spaces } = useSpaceStore.getState()
      const allSpaceIds = [
        ...(haloSpace ? [haloSpace.id] : []),
        ...spaces.map(s => s.id)
      ].filter(id => id !== currentSpace.id)
      preloadAllSpaceConversations(allSpaceIds)

      // After loading, check if we need to select or create a conversation
      const store = useChatStore.getState()
      const spaceState = store.getSpaceState(currentSpace.id)

      // Consume pending Pulse navigation (cross-space jump from PulseList)
      const pendingNav = store.pendingPulseNavigation
      if (pendingNav) {
        useChatStore.setState({ pendingPulseNavigation: null })
        selectConversation(pendingNav)
      } else if (spaceState.conversations.length > 0) {
        // If no conversation selected, select the first one
        if (!spaceState.currentConversationId) {
          selectConversation(spaceState.conversations[0].id)
        }
      } else {
        // No conversations exist - create a new one
        await createConversation(currentSpace.id)
      }
    }

    initSpace()
  }, [currentSpace?.id]) // Only re-run when space ID changes

  // Handle back
  const handleBack = () => {
    setView('home')
  }

  // Handle new conversation
  const handleNewConversation = async () => {
    if (currentSpace) {
      await createConversation(currentSpace.id)
    }
  }

  // Handle open folder
  const handleOpenFolder = () => {
    if (currentSpace) {
      openSpaceFolder(currentSpace.id)
    }
  }

  if (!currentSpace) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <p className="text-muted-foreground">No space selected</p>
      </div>
    )
  }

  // Handle delete conversation
  const handleDeleteConversation = async (conversationId: string) => {
    if (currentSpace) {
      await deleteConversation(currentSpace.id, conversationId)
    }
  }

  // Handle rename conversation
  const handleRenameConversation = async (conversationId: string, newTitle: string) => {
    if (currentSpace) {
      await renameConversation(currentSpace.id, conversationId, newTitle)
    }
  }

  // Handle star/unstar conversation
  const handleStarConversation = async (conversationId: string, starred: boolean) => {
    if (currentSpace) {
      await toggleStarConversation(currentSpace.id, conversationId, starred)
    }
  }

  // Exit maximized mode when canvas closes
  useEffect(() => {
    if (!isCanvasOpen && isCanvasMaximized) {
      setCanvasMaximized(false)
    }
  }, [isCanvasOpen, isCanvasMaximized, setCanvasMaximized])

  // Auto-collapse rail when entering maximized mode, restore when exiting
  const prevMaximizedRef = useRef(isCanvasMaximized)
  const railExpandedBeforeMaximize = useRef(effectiveRailExpanded)

  useEffect(() => {
    if (isCanvasMaximized && !prevMaximizedRef.current) {
      // Entering maximized mode - save current state and collapse
      railExpandedBeforeMaximize.current = effectiveRailExpanded
      if (effectiveRailExpanded) {
        setRailExpanded(false)
      }
      // Show overlay chat capsule (renders above BrowserView)
      if (!isMobile) {
        api.showChatCapsuleOverlay()
      }
    } else if (!isCanvasMaximized && prevMaximizedRef.current) {
      // Exiting maximized mode - restore previous state
      if (railExpandedBeforeMaximize.current) {
        setRailExpanded(true)
      }
      // Hide overlay chat capsule
      if (!isMobile) {
        api.hideChatCapsuleOverlay()
      }
    }
    prevMaximizedRef.current = isCanvasMaximized
  }, [isCanvasMaximized, effectiveRailExpanded, setRailExpanded, isMobile])

  // Listen for exit-maximized event from overlay
  useEffect(() => {
    const cleanup = api.onCanvasExitMaximized(() => {
      console.log('[SpacePage] Received exit-maximized from overlay')
      setCanvasMaximized(false)
    })
    return cleanup
  }, [setCanvasMaximized])

  // Setup search shortcuts
  useSearchShortcuts({
    enabled: true,
    onSearch: (scope) => openSearch(scope)
  })

  return (
    <div className="h-full w-full flex flex-col">
      {/*
        ChatCapsule overlay is now managed via IPC to render above BrowserView.
        The overlay SPA is a separate WebContentsView that appears above all views.
        Show/hide is controlled by api.showChatCapsuleOverlay() / api.hideChatCapsuleOverlay()
      */}

      {/* Header - replaced with drag region spacer when maximized (for macOS traffic lights) */}
      {isCanvasMaximized ? (
        <div
          className="h-11 flex-shrink-0 bg-background"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />
      ) : (
      <Header
        left={
          <>
            <button
              onClick={handleBack}
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            <SpaceIcon iconId={currentSpace.icon} size={22} className="flex-shrink-0" />
            <span className="font-medium text-sm truncate max-w-[100px] sm:max-w-[200px] hidden sm:inline">
              {currentSpace.isTemp ? 'Halo' : currentSpace.name}
            </span>

            {/* Chat History Panel - integrated in header */}
            {conversations.length > 0 && (
              <div className="ml-1">
                <ChatHistoryPanel
                  conversations={conversations}
                  currentConversationId={currentConversationId}
                  onSelect={(id) => selectConversation(id)}
                  onNew={handleNewConversation}
                  onDelete={handleDeleteConversation}
                  onRename={handleRenameConversation}
                  onStar={handleStarConversation}
                  spaceName={currentSpace.isTemp ? t('Halo Space') : currentSpace.name}
                  onToggleSidebar={() => setShowConversationList(!showConversationList)}
                  isSidebarVisible={showConversationList}
                />
              </div>
            )}

            {/* Pulse Beacon - only shown in degraded mode (narrow window / mobile) */}
            {pulseMode === 'beacon' && <PulseBeacon />}
          </>
        }
        right={
          <>
            {/* New conversation button for all spaces */}
            <button
              onClick={handleNewConversation}
              className="flex items-center gap-1.5 px-2.5 py-1 text-sm hover:bg-secondary rounded-lg transition-colors"
              title={t('New conversation')}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <span className="hidden sm:inline">{t('New conversation')}</span>
            </button>

            {/* Search Icon - hidden on mobile, accessible via shortcut */}
            <div className="hidden sm:block">
              <SearchIcon onClick={openSearch} isInSpace={true} />
            </div>

            {/* Model Selector */}
            <ModelSelector />

            <button
              onClick={() => setView('settings')}
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
              title={t('Settings')}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </>
        }
      />
      )}

      {/* Git Bash Warning Banner - Windows only, when in mock mode */}
      {mockBashMode && !isCanvasMaximized && (
        <GitBashWarningBanner
          installProgress={gitBashInstallProgress}
          onInstall={startGitBashInstall}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Conversation list sidebar - hidden when maximized */}
        {showConversationList && !isCanvasMaximized && (
          <ConversationList
            conversations={conversations}
            currentConversationId={currentConversationId}
            onSelect={(id) => selectConversation(id)}
            onNew={handleNewConversation}
            onDelete={handleDeleteConversation}
            onRename={handleRenameConversation}
            onStar={handleStarConversation}
            showPulse={pulseMode === 'sidebar'}
          />
        )}

        {/* Desktop Layout */}
        {!isMobile && (
          <>
            {/* Chat view - hidden when maximized, adjusts width based on canvas state */}
            {!isCanvasMaximized && (
              <div
                ref={chatContainerRef}
                className={`
                  flex flex-col min-w-0 relative
                  ${isCanvasOpen ? 'border-r border-border/60' : 'flex-1 border-r border-transparent'}
                `}
                style={{
                  width: isCanvasOpen ? dragChatWidth : undefined,
                  flex: isCanvasOpen ? 'none' : '1',
                  minWidth: isCanvasOpen ? chatWidthMin : undefined,
                  maxWidth: isCanvasOpen ? chatWidthMax : undefined,
                }}
              >
                <ChatView isCompact={isCanvasOpen} />

                {/* Pulse Inline Panel - Form A: absolute overlay, no layout shift */}
                {pulseMode === 'inline' && (
                  <PulseInlinePanel
                    collapsed={pulseCollapsed}
                    onCollapsedChange={setPulseCollapsed}
                  />
                )}

                {/* Drag handle for chat width - only when canvas is open */}
                {isCanvasOpen && (
                  <div
                    className={`
                      absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-20
                      hover:bg-primary/50 transition-colors
                      ${isDraggingChat ? 'bg-primary/50' : ''}
                    `}
                    onMouseDown={handleChatDragStart}
                    title={t('Drag to resize')}
                  />
                )}
              </div>
            )}

            {/* Content Canvas - main viewing area when open, full width when maximized */}
            <div
              className={`
                min-w-0 overflow-hidden
                ${isCanvasOpen || isCanvasMaximized
                  ? 'flex-1 opacity-100'
                  : 'w-0 flex-none opacity-0'}
              `}
            >
              {(isCanvasOpen || isCanvasMaximized || isCanvasTransitioning) && <ContentCanvas />}
            </div>
          </>
        )}

        {/* Mobile Layout */}
        {isMobile && (
          <div className="flex-1 flex flex-col min-w-0">
            <ChatView isCompact={false} />
          </div>
        )}

        {/* Artifact rail - auto-collapses when maximized via useEffect above */}
        {/* Smart collapse: collapses when canvas is open, respects user preference */}
        {!isMobile && (
          <ArtifactRail
            spaceId={currentSpace.id}
            isTemp={currentSpace.isTemp}
            onOpenFolder={handleOpenFolder}
            externalExpanded={effectiveRailExpanded}
            onExpandedChange={setRailExpanded}
          />
        )}
      </div>

      {/* Mobile Canvas Overlay */}
      {isMobile && isCanvasOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background animate-slide-in-right-full">
          {/* Mobile Canvas Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/80 backdrop-blur-sm">
            <button
              onClick={() => setCanvasOpen(false)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
            >
              <MessageSquare className="w-4 h-4" />
              <span>{t('Return to conversation')}</span>
            </button>
            <button
              onClick={() => setCanvasOpen(false)}
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Mobile Canvas Content */}
          <div className="flex-1 overflow-hidden">
            <ContentCanvas />
          </div>
        </div>
      )}

      {/* Mobile Artifact Rail (shown as bottom sheet / overlay) */}
      {isMobile && (
        <ArtifactRail
          spaceId={currentSpace.id}
          isTemp={currentSpace.isTemp}
          onOpenFolder={handleOpenFolder}
        />
      )}
    </div>
  )
}
