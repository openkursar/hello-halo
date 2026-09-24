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
import { SpaceSelector } from '../components/layout/SpaceSelector'
import { ModelSelector } from '../components/layout/ModelSelector'
import { QuotaPill } from '../components/layout/QuotaPill'
import { MobileOverflowMenu } from '../components/layout/MobileOverflowMenu'
import { HeaderMoreMenu } from '../components/layout/HeaderMoreMenu'
import { ContentCanvas, TerminalCloseGuard } from '../components/canvas'
import { GitBashWarningBanner } from '../components/setup/GitBashWarningBanner'
import { api } from '../api'
import { useLayoutPreferences } from '../hooks/useLayoutPreferences'
import { useConversationTouchedFiles } from '../hooks/useConversationTouchedFiles'
import { useWindowMaximize } from '../components/canvas/viewers/useWindowMaximize'
import { X, MessageSquare, Folder } from 'lucide-react'
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
  const mockBashMode = useAppStore(state => state.mockBashMode)
  const gitBashInstallProgress = useAppStore(state => state.gitBashInstallProgress)
  const startGitBashInstall = useAppStore(state => state.startGitBashInstall)
  const artifactRailWidthConfig = useAppStore(state => state.config?.layout?.artifactRailWidth)

  // Active source id for the header quota pill (string identity → re-renders
  // only when the selection actually changes).
  const currentSourceId = useAppStore(state => {
    const src = state.config?.aiSources
    return src?.version === 2 && src.currentId && src.sources.some(s => s.id === src.currentId)
      ? src.currentId
      : undefined
  })

  const currentSpace = useSpaceStore(state => state.currentSpace)

  // For mobile ChatHistoryPanel visibility check
  const hasConversations = useChatStore(state => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '')
    return (spaceState?.conversations?.length ?? 0) > 0
  })

  const currentConversationId = useChatStore(state => state.getCurrentSpaceState().currentConversationId)

  // Centered header title — name of the conversation currently open
  const currentConversationTitle = useChatStore(state => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '')
    const id = spaceState?.currentConversationId
    if (!id) return undefined
    return spaceState?.conversations?.find(c => c.id === id)?.title || undefined
  })

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
      void canvasLifecycle.enterSpace(currentSpace.id)
    }
  }, [currentSpace?.id])

  // Showing a native BrowserView requires the canvas container's bounds, so it
  // belongs to BrowserViewer, which owns that ref and remounts with the canvas.
  // SpacePage owns only the teardown: leaving the page or switching space must
  // not leave a native view floating over whatever renders next.
  useEffect(() => {
    if (!currentSpace) return

    return () => {
      canvasLifecycle.hideAllBrowserViews()
    }
  }, [currentSpace?.id])

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

      // Consume pending digital-human navigation (cross-space jump from the
      // detail page's "Chat" button or the resource rail's hover action).
      // Checked before the regular Pulse nav — the two are mutually exclusive
      // per triggering action, so order between them doesn't matter in practice.
      const pendingAppChatNav = store.pendingAppChatNavigation
      if (pendingAppChatNav) {
        useChatStore.setState({ pendingAppChatNavigation: null })
        useChatStore.getState().selectAppChatConversation(currentSpace.id, pendingAppChatNav.appId, pendingAppChatNav.conversationId)
        return
      }

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

  // Auto-open the artifact rail the moment the AI writes or edits a file in
  // the conversation you're actively watching, so a closed rail doesn't
  // hide the fact that local files just changed. Scoped to growth *within*
  // the same conversation — switching to a different (or brand-new) one
  // just resyncs the baseline below, it never forces the rail open, since
  // that conversation's changes aren't new right now.
  const touchedFiles = useConversationTouchedFiles()
  const touchedFilesBaselineRef = useRef({ conversationId: currentConversationId, size: touchedFiles.size })

  useEffect(() => {
    const baseline = touchedFilesBaselineRef.current
    const sameConversation = baseline.conversationId === currentConversationId
    if (sameConversation && touchedFiles.size > baseline.size && !effectiveRailExpanded) {
      setRailExpanded(true)
    }
    touchedFilesBaselineRef.current = { conversationId: currentConversationId, size: touchedFiles.size }
  }, [touchedFiles, currentConversationId, effectiveRailExpanded, setRailExpanded])

  // Consume a workspace card's asset-chip request (space.store's
  // pendingArtifactRailTab, set by SpacesPage before switching here) — force
  // the rail open on the requested tab, then clear so a later manual
  // collapse doesn't get silently re-opened by a stale pending value.
  const pendingArtifactRailTab = useSpaceStore(state => state.pendingArtifactRailTab)
  useEffect(() => {
    if (!pendingArtifactRailTab) return
    setRailExpanded(true)
    useSpaceStore.getState().setPendingArtifactRailTab(null)
  }, [pendingArtifactRailTab, setRailExpanded])

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

  if (!currentSpace) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <p className="text-muted-foreground">{t('No workspace selected')}</p>
      </div>
    )
  }

  return (
    <div className="h-full w-full flex flex-col">
      {/* Terminal pty close policy — mounted here (not in the canvas) so it stays
          active for closeAll/space-switch teardown even when the canvas is
          collapsed. Renders its prompt via a portal; no layout footprint. */}
      <TerminalCloseGuard />

      {/*
        ChatCapsule overlay is now managed via IPC to render above BrowserView.
        The overlay SPA is a separate WebContentsView that appears above all views.
        Show/hide is controlled by api.showChatCapsuleOverlay() / api.hideChatCapsuleOverlay()
      */}

      {/* Header — hidden (bare drag strip) when the canvas is maximized, since
          there's no chrome to show and the strip still needs to be draggable
          and clear the macOS traffic lights. */}
      <Header
        hidden={isCanvasMaximized}
        title={!isMobile ? currentConversationTitle : undefined}
        left={
          <>
            {/* Space Selector - dropdown for switching spaces (includes icon + name + "Manage Spaces") */}
            <SpaceSelector />

            {/* Global search — prototype `.hsearch` sits directly after the
                space selector, on the left, not grouped with the right-side
                quota/model/rail icons. Hidden on mobile (reachable via the
                overflow menu instead). */}
            <div className="hidden sm:block">
              <SearchIcon onClick={openSearch} isInSpace={true} />
            </div>

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
            {/* Metered quota — renders only when the active source reports it */}
            <QuotaPill sourceId={currentSourceId} />

            {/* Model Selector - hidden on mobile (in overflow menu) */}
            <div className="hidden sm:block">
              <ModelSelector />
            </div>

            {/* Space resources rail toggle - desktop only; mobile reaches the
                rail via its own floating trigger button. Prototype `#railBtn`
                is a folder glyph (Files/Skill/MCP = "space resources"), not a
                generic panel icon — and `.icon-btn`: 32×32, rounded-sm(8px),
                17×17 icon, active state tints when the rail is open. */}
            <div className="hidden sm:block">
              <button
                onClick={() => setRailExpanded(!effectiveRailExpanded)}
                className={`w-8 h-8 rounded-sm flex items-center justify-center transition-colors ease-halo ${
                  effectiveRailExpanded
                    ? 'bg-primary/[0.12] text-accent-on-dark'
                    : 'text-subtle-foreground hover:bg-secondary hover:text-foreground'
                }`}
                title={effectiveRailExpanded ? t('Close workspace resources') : t('Open workspace resources')}
                aria-pressed={effectiveRailExpanded}
              >
                <Folder className="w-[17px] h-[17px]" strokeWidth={1.8} />
              </button>
            </div>

            <HeaderMoreMenu />

            {/* Mobile: overflow menu collapses model/search/settings */}
            <MobileOverflowMenu onSearch={() => openSearch('space')} />
          </>
        }
      />

      {/* Git Bash Warning Banner - Windows only, when in mock mode */}
      {mockBashMode && !isCanvasMaximized && (
        <GitBashWarningBanner
          installProgress={gitBashInstallProgress}
          onInstall={startGitBashInstall}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Conversation list sidebar - always visible on desktop (prototype has
            no "fully hidden" state, only the canvas-open narrow one); width
            drag-resize and the canvas-open collapse still apply. Unmounted
            when the canvas is maximized (matches the chat view) or on mobile. */}
        {!isMobile && !isCanvasMaximized && (
          <ConversationList collapsed={isCanvasOpen} />
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

        {/* Artifact rail - defaults collapsed and auto-opens when the
            conversation writes/edits files, or a workspace card's asset chip
            asks for a specific tab (both effects above); otherwise follows
            the user's own toggle, persisted per space. Only exception:
            forced closed while the canvas is maximized (see useEffect
            above), restoring on exit. */}
        {!isMobile && (
          <ArtifactRail
            externalExpanded={effectiveRailExpanded}
            onExpandedChange={setRailExpanded}
            initialTab={pendingArtifactRailTab ?? undefined}
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
