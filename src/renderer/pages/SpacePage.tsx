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
import { Header } from '../components/layout/Header'
import { SidebarToggle } from '../components/layout/SidebarToggle'
import { SpaceSelector } from '../components/layout/SpaceSelector'
import { ModelSelector } from '../components/layout/ModelSelector'
import { ContentCanvas } from '../components/canvas'
import { GitBashWarningBanner } from '../components/setup/GitBashWarningBanner'
import { api } from '../api'
import { useLayoutPreferences } from '../hooks/useLayoutPreferences'
import { useWindowMaximize } from '../components/canvas/viewers/useWindowMaximize'
import { X, MessageSquare } from 'lucide-react'
import { SearchIcon } from '../components/search/SearchIcon'
import { useSearchShortcuts } from '../hooks/useSearchShortcuts'
import { useTranslation } from '../i18n'
import { useIsMobile } from '../hooks/useIsMobile'
import type { LayoutConfig } from '../types'

/** Persist a partial layout update to backend config + sync in-memory store */
function persistLayout(update: Partial<LayoutConfig>) {
  const currentConfig = useAppStore.getState().config
  if (currentConfig) {
    useAppStore.getState().updateConfig({ layout: { ...currentConfig.layout, ...update } })
  }
  api.setConfig({ layout: update }).catch(err =>
    console.error('[SpacePage] Failed to persist layout:', err)
  )
}

export function SpacePage() {
  const { t } = useTranslation()

  // Precise selectors — only subscribe to what SpacePage needs for layout orchestration
  const setView = useAppStore(state => state.setView)
  const mockBashMode = useAppStore(state => state.mockBashMode)
  const gitBashInstallProgress = useAppStore(state => state.gitBashInstallProgress)
  const startGitBashInstall = useAppStore(state => state.startGitBashInstall)
  const sidebarOpenConfig = useAppStore(state => state.config?.layout?.sidebarOpen)
  const artifactRailWidthConfig = useAppStore(state => state.config?.layout?.artifactRailWidth)

  const currentSpace = useSpaceStore(state => state.currentSpace)

  // For mobile ChatHistoryPanel visibility check
  const hasConversations = useChatStore(state => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '')
    return (spaceState?.conversations?.length ?? 0) > 0
  })

  // Show conversation list (persisted globally in config)
  const [showConversationList, setShowConversationList] = useState(
    sidebarOpenConfig ?? false
  )

  // Sync sidebar state when config loads asynchronously
  const sidebarOpenInitialized = useRef(false)
  useEffect(() => {
    if (sidebarOpenConfig !== undefined && !sidebarOpenInitialized.current) {
      setShowConversationList(sidebarOpenConfig)
      sidebarOpenInitialized.current = true
    }
  }, [sidebarOpenConfig])

  // Canvas state - use precise selectors to minimize re-renders
  const isCanvasOpen = useCanvasIsOpen()
  const isCanvasMaximized = useCanvasIsMaximized()
  const isCanvasTransitioning = useCanvasStore(state => state.isTransitioning)
  const setCanvasOpen = useCanvasStore(state => state.setOpen)
  const setCanvasMaximized = useCanvasStore(state => state.setMaximized)

  // Mobile detection
  const isMobile = useIsMobile()

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

    // Set current space in chat store (fire-and-forget, no subscription)
    useChatStore.getState().setCurrentSpace(currentSpace.id)

    // Load conversations if not already loaded for this space
    const initSpace = async () => {
      await useChatStore.getState().loadConversations(currentSpace.id)

      // Preload other spaces' conversations in background for PULSE global visibility
      const { haloSpace, spaces } = useSpaceStore.getState()
      const allSpaceIds = [
        ...(haloSpace ? [haloSpace.id] : []),
        ...spaces.map(s => s.id)
      ].filter(id => id !== currentSpace.id)
      useChatStore.getState().preloadAllSpaceConversations(allSpaceIds)

      // After loading, check if we need to select or create a conversation
      const store = useChatStore.getState()
      const spaceState = store.getSpaceState(currentSpace.id)

      // Consume pending Pulse navigation (cross-space jump from PulseList)
      const pendingNav = store.pendingPulseNavigation
      if (pendingNav) {
        useChatStore.setState({ pendingPulseNavigation: null })
        useChatStore.getState().selectConversation(pendingNav)
      } else if (spaceState.conversations.length > 0) {
        // If no conversation selected, select the first one
        if (!spaceState.currentConversationId) {
          useChatStore.getState().selectConversation(spaceState.conversations[0].id)
        }
      } else {
        // No conversations exist - create a new one
        await useChatStore.getState().createConversation(currentSpace.id)
      }
    }

    initSpace()
  }, [currentSpace?.id]) // Only re-run when space ID changes

  // Toggle conversation list sidebar with global persistence
  const handleToggleConversationList = useCallback(() => {
    const newValue = !showConversationList
    setShowConversationList(newValue)
    persistLayout({ sidebarOpen: newValue })
  }, [showConversationList])

  // Persist artifact rail width on drag end
  const handleArtifactRailWidthChange = useCallback((width: number) => {
    persistLayout({ artifactRailWidth: width })
  }, [])

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

  // Handle new conversation (still needed for header button)
  const handleNewConversation = useCallback(async () => {
    if (currentSpace) {
      await useChatStore.getState().createConversation(currentSpace.id)
    }
  }, [currentSpace])

  if (!currentSpace) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <p className="text-muted-foreground">No space selected</p>
      </div>
    )
  }

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
            {/* Back button */}
            <button
              onClick={() => setView('home')}
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            {/* Space Selector - dropdown for switching spaces (includes icon + name + back) */}
            <SpaceSelector />

            {/* Mobile: Chat History Panel as bottom sheet */}
            {isMobile && hasConversations && (
              <div className="ml-1">
                <ChatHistoryPanel />
              </div>
            )}
          </>
        }
        right={
          <>
            {/* New conversation button */}
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
        {/* Conversation list sidebar - CSS hidden when collapsed or maximized, unmounted on mobile */}
        {!isMobile && (
          <div style={{ display: showConversationList && !isCanvasMaximized ? 'flex' : 'none' }}>
            <ConversationList
              onClose={handleToggleConversationList}
              visible={showConversationList && !isCanvasMaximized}
            />
          </div>
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

                {/* Floating sidebar toggle - shows when sidebar is closed */}
                {!showConversationList && (
                  <div className="absolute top-2 left-0 z-10">
                    <SidebarToggle
                      isOpen={false}
                      onToggle={handleToggleConversationList}
                    />
                  </div>
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
            externalExpanded={effectiveRailExpanded}
            onExpandedChange={setRailExpanded}
            initialWidth={artifactRailWidthConfig}
            onWidthChange={handleArtifactRailWidthChange}
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
        <ArtifactRail />
      )}
    </div>
  )
}
