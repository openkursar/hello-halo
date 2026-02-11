/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Halo - Main App Component
 */

import { useEffect, useRef, Suspense, lazy } from 'react'
import { useAppStore } from './stores/app.store'
import { useChatStore } from './stores/chat.store'
import { useOnboardingStore } from './stores/onboarding.store'
import { initAIBrowserStoreListeners } from './stores/ai-browser.store'
import { initPerfStoreListeners } from './stores/perf.store'
import { useSpaceStore } from './stores/space.store'
import { useSearchStore } from './stores/search.store'
import { SplashScreen } from './components/splash/SplashScreen'
import { SetupFlow } from './components/setup/SetupFlow'
import { GitBashSetup } from './components/setup/GitBashSetup'
import { SearchPanel } from './components/search/SearchPanel'
import { SearchHighlightBar } from './components/search/SearchHighlightBar'
import { OnboardingOverlay } from './components/onboarding'
import { UpdateNotification } from './components/updater/UpdateNotification'
import { api } from './api'
import type { AgentEventBase, Thought, ToolCall, HaloConfig, AgentErrorType, Question } from './types'
import { hasAnyAISource } from './types'

// Lazy load heavy page components for better initial load performance
// These pages contain complex components (chat, markdown, code highlighting, etc.)
const HomePage = lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })))
const SpacePage = lazy(() => import('./pages/SpacePage').then(m => ({ default: m.SpacePage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })))

// Page loading fallback - minimal spinner that matches app style
function PageLoader() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    </div>
  )
}

// Theme colors for titleBarOverlay
const THEME_COLORS = {
  light: { color: '#ffffff', symbolColor: '#1a1a1a' },
  dark: { color: '#0a0a0a', symbolColor: '#ffffff' }
}

// Apply theme to document and sync to localStorage (for anti-flash on reload)
function applyTheme(theme: 'light' | 'dark' | 'system') {
  const root = document.documentElement

  // Save to localStorage for anti-flash script
  try {
    localStorage.setItem('halo-theme', theme)
  } catch (e) { /* ignore */ }

  let isDark: boolean
  if (theme === 'system') {
    isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.classList.toggle('light', !isDark)
  } else {
    isDark = theme === 'dark'
    root.classList.toggle('light', theme === 'light')
  }

  // Update titleBarOverlay colors (Windows/Linux only)
  const colors = isDark ? THEME_COLORS.dark : THEME_COLORS.light
  api.setTitleBarOverlay(colors).catch(() => {
    // Ignore errors - may not be supported on current platform
  })
}

export default function App() {
  const { view, config, initialize, setMcpStatus, setView, setConfig } = useAppStore()
  const {
    handleAgentMessage,
    handleAgentToolCall,
    handleAgentToolResult,
    handleAgentError,
    handleAgentComplete,
    handleAgentThought,
    handleAgentThoughtDelta,
    handleAgentCompact,
    handleAskQuestion,
    currentSpaceId,
    setCurrentSpace: setChatCurrentSpace,
    loadConversations,
    selectConversation
  } = useChatStore()
  const { initialize: initializeOnboarding } = useOnboardingStore()
  const { isSearchOpen, closeSearch, isHighlightBarVisible, hideHighlightBar, goToPreviousResult, goToNextResult, openSearch } = useSearchStore()

  // For search result navigation
  const { spaces, haloSpace, setCurrentSpace: setSpaceStoreCurrentSpace } = useSpaceStore()

  // Initialize app on mount - wait for backend extended services to be ready
  // Uses Pull+Push pattern for reliable initialization:
  // - Pull: Query status immediately (handles HMR, error recovery - 0ms delay)
  // - Push: Listen for event (normal startup flow)
  // - Timeout: Fallback protection if something goes wrong
  useEffect(() => {
    let initialized = false
    const startTime = Date.now()
    console.log('[App] Mounted, initializing with Pull+Push pattern...')

    const doInit = async (trigger: 'query' | 'event' | 'timeout') => {
      if (initialized) return
      initialized = true

      const waitTime = Date.now() - startTime
      console.log(`[App] Starting initialization (trigger: ${trigger}, waited: ${waitTime}ms)`)

      await initialize()
      // Initialize onboarding after app config is loaded
      await initializeOnboarding()
    }

    // 1. Pull: Query current status immediately
    // This handles HMR reload and error recovery scenarios where event was already sent
    api.getBootstrapStatus().then(status => {
      if (status.extendedReady) {
        console.log('[App] Bootstrap status: already ready, initializing immediately')
        doInit('query')
      } else {
        console.log('[App] Bootstrap status: not ready, waiting for event...')
      }
    }).catch(err => {
      console.warn('[App] Failed to query bootstrap status:', err)
    })

    // 2. Push: Listen for extended services ready event from main process
    // This is the normal startup flow for fresh app launch
    const unsubscribe = api.onBootstrapExtendedReady((data) => {
      console.log('[App] Received bootstrap:extended-ready', data)
      doInit('event')
    })

    // 3. Timeout: Fallback protection if something goes wrong
    // Reduced to 5s since we now have Pull mechanism as primary fast path
    const fallbackTimeout = setTimeout(() => {
      if (!initialized) {
        console.warn('[App] Bootstrap timeout after 5000ms, force initializing...')
        doInit('timeout')
      }
    }, 5000)

    return () => {
      unsubscribe()
      clearTimeout(fallbackTimeout)
    }
  }, [initialize, initializeOnboarding])

  // Theme switching
  useEffect(() => {
    // Default to 'dark' before config loads, then use config value
    const theme = config?.appearance?.theme || 'dark'
    applyTheme(theme)

    // Listen for system theme changes when using 'system' mode
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const handleChange = () => applyTheme('system')
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }
  }, [config?.appearance?.theme])

  // Connect WebSocket for remote mode
  useEffect(() => {
    if (api.isRemoteMode()) {
      console.log('[App] Remote mode detected, connecting WebSocket...')
      api.connectWebSocket()
    }
  }, [])

  // Initialize AI Browser IPC listeners for active view sync
  useEffect(() => {
    console.log('[App] Initializing AI Browser store listeners')
    initPerfStoreListeners()
    const cleanup = initAIBrowserStoreListeners()
    return cleanup
  }, [])

  // Register agent event listeners (global - handles events for all conversations)
  useEffect(() => {
    console.log('[App] Registering agent event listeners')

    // Primary thought listener - handles all agent reasoning events
    const unsubThought = api.onAgentThought((data) => {
      console.log('[App] Received agent:thought event:', data)
      handleAgentThought(data as AgentEventBase & { thought: Thought })
    })

    // Thought delta listener - handles incremental updates to streaming thoughts
    const unsubThoughtDelta = api.onAgentThoughtDelta((data) => {
      // Don't log every delta to reduce noise
      handleAgentThoughtDelta(data as AgentEventBase & {
        thoughtId: string
        delta?: string
        content?: string
        toolInput?: Record<string, unknown>
        isComplete?: boolean
        isReady?: boolean
        isToolInput?: boolean
      })
    })

    // Message events (with session IDs)
    const unsubMessage = api.onAgentMessage((data) => {
      // console.log('[App] Received agent:message event:', data)
      handleAgentMessage(data as AgentEventBase & { content: string; isComplete: boolean })
    })

    const unsubToolCall = api.onAgentToolCall((data) => {
      console.log('[App] Received agent:tool-call event:', data)
      handleAgentToolCall(data as AgentEventBase & ToolCall)
    })

    const unsubToolResult = api.onAgentToolResult((data) => {
      console.log('[App] Received agent:tool-result event:', data)
      handleAgentToolResult(data as AgentEventBase & { toolId: string; result: string; isError: boolean })
    })

    const unsubError = api.onAgentError((data) => {
      console.log('[App] Received agent:error event:', data)
      handleAgentError(data as AgentEventBase & { error: string; errorType?: AgentErrorType })
    })

    const unsubComplete = api.onAgentComplete((data) => {
      console.log('[App] Received agent:complete event:', data)
      handleAgentComplete(data as AgentEventBase)
    })

    const unsubCompact = api.onAgentCompact((data) => {
      console.log('[App] Received agent:compact event:', data)
      handleAgentCompact(data as AgentEventBase & { trigger: 'manual' | 'auto'; preTokens: number })
    })

    // AskUserQuestion - AI needs user input to continue
    const unsubAskQuestion = api.onAgentAskQuestion((data) => {
      console.log('[App] Received agent:ask-question event:', data)
      handleAskQuestion(data as AgentEventBase & { id: string; questions: Question[] })
    })

    // MCP status updates (global - not per-conversation)
    const unsubMcpStatus = api.onAgentMcpStatus((data) => {
      console.log('[App] Received agent:mcp-status event:', data)
      const event = data as { servers: Array<{ name: string; status: string }>; timestamp: number }
      if (event.servers) {
        setMcpStatus(event.servers as any, event.timestamp)
      }
    })

    return () => {
      unsubThought()
      unsubThoughtDelta()
      unsubMessage()
      unsubToolCall()
      unsubToolResult()
      unsubError()
      unsubComplete()
      unsubCompact()
      unsubAskQuestion()
      unsubMcpStatus()
    }
  }, [
    handleAgentMessage,
    handleAgentToolCall,
    handleAgentToolResult,
    handleAgentError,
    handleAgentComplete,
    handleAgentThought,
    handleAgentThoughtDelta,
    handleAgentCompact,
    handleAskQuestion,
    setMcpStatus
  ])

  // Handle search keyboard shortcuts with debouncing for navigation
  // Use ref to maintain debounce timer across renders
  const navigationDebounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const pendingNavigationRef = useRef<(() => void) | null>(null)

  const debouncedNavigate = (callback: () => void) => {
    // Clear previous timeout
    if (navigationDebounceTimerRef.current) {
      clearTimeout(navigationDebounceTimerRef.current)
    }

    // Store the pending navigation
    pendingNavigationRef.current = callback

    // Set new timeout - debounce for 300ms
    navigationDebounceTimerRef.current = setTimeout(() => {
      console.log('[App] Executing debounced keyboard navigation')
      pendingNavigationRef.current?.()
      pendingNavigationRef.current = null
      navigationDebounceTimerRef.current = null
    }, 300)
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle when highlight bar is visible
      if (!isHighlightBarVisible) return

      const isMac = typeof navigator !== 'undefined' &&
        navigator.platform.toUpperCase().indexOf('MAC') >= 0

      // Esc - Close highlight bar (no debounce needed)
      if (e.key === 'Escape') {
        e.preventDefault()
        hideHighlightBar()
        return
      }

      // Arrow up - Navigate to earlier result (with debounce)
      // Note: In time-sorted results (newest first), earlier = higher index
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        debouncedNavigate(() => {
          console.log('[App] Keyboard: navigating to earlier result')
          goToNextResult() // goToNextResult increases index = earlier in time
        })
        return
      }

      // Arrow down - Navigate to more recent result (with debounce)
      // Note: In time-sorted results (newest first), more recent = lower index
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        debouncedNavigate(() => {
          console.log('[App] Keyboard: navigating to more recent result')
          goToPreviousResult() // goToPreviousResult decreases index = more recent in time
        })
        return
      }

      // Ctrl+K / Cmd+K - Open search to edit (no debounce needed)
      const metaKey = isMac ? e.metaKey : e.ctrlKey
      if (metaKey && e.key === 'k' && !e.shiftKey) {
        e.preventDefault()
        openSearch()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isHighlightBarVisible, hideHighlightBar, goToPreviousResult, goToNextResult, openSearch])

  // Handle search result navigation from highlight bar
  // This handles the complete navigation flow when user clicks [↑][↓] or uses arrow keys
  useEffect(() => {
    const handleNavigateToResult = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        messageId: string
        spaceId: string
        conversationId: string
        query: string
        resultIndex: number
      }>

      const { messageId, spaceId, conversationId, query } = customEvent.detail

      console.log(`[App] search:navigate-to-result event - space=${spaceId}, conv=${conversationId}, msg=${messageId}`)

      try {
        // Step 1: If switching spaces, update both stores
        if (spaceId !== currentSpaceId) {
          console.log(`[App] Switching to space: ${spaceId}`)

          // Find the space object
          let targetSpace = null
          if (spaceId === 'halo-temp' && haloSpace) {
            targetSpace = haloSpace
          } else {
            targetSpace = spaces.find(s => s.id === spaceId)
          }

          if (!targetSpace) {
            console.error(`[App] Space not found: ${spaceId}`)
            return
          }

          // Update spaceStore
          console.log(`[App] Updating space to: ${targetSpace.name}`)
          setSpaceStoreCurrentSpace(targetSpace)

          // Update chatStore
          setChatCurrentSpace(spaceId)

          // Give state time to update
          await new Promise(resolve => setTimeout(resolve, 50))
        }

        // Step 2: Load conversations if needed
        console.log(`[App] Loading conversations for space: ${spaceId}`)
        await loadConversations(spaceId)

        // Step 3: Select conversation
        console.log(`[App] Selecting conversation: ${conversationId}`)
        await selectConversation(conversationId)

        // Step 4: Dispatch navigation event for ChatView to handle
        // ChatView uses Virtuoso scrollToIndex to bring the message into viewport,
        // then applies DOM highlighting — no need to pre-check DOM existence here.
        // Small delay to let conversation data load and MessageList mount.
        setTimeout(() => {
          console.log(`[App] Dispatching navigate-to-message for: ${messageId}`)
          const navEvent = new CustomEvent('search:navigate-to-message', {
            detail: {
              messageId,
              query
            }
          })
          window.dispatchEvent(navEvent)
        }, 300)
      } catch (error) {
        console.error(`[App] Error navigating to result:`, error)
      }
    }

    window.addEventListener('search:navigate-to-result', handleNavigateToResult)
    return () => window.removeEventListener('search:navigate-to-result', handleNavigateToResult)
  }, [currentSpaceId, spaces, haloSpace, setSpaceStoreCurrentSpace, setChatCurrentSpace, loadConversations, selectConversation])

  // Handle Git Bash setup completion
  const handleGitBashSetupComplete = async (installed: boolean) => {
    console.log('[App] Git Bash setup completed, installed:', installed)

    // Save skip preference if not installed
    if (!installed) {
      await api.setConfig({ gitBash: { skipped: true, installed: false, path: null } })
    }

    // Continue with normal initialization - sync config to store
    const response = await api.getConfig()
    if (response.success && response.data) {
      const loadedConfig = response.data as HaloConfig
      setConfig(loadedConfig)  // Sync config to store (was missing, causing empty apiKey in settings)
      // Show setup if first launch or no AI source configured
      if (loadedConfig.isFirstLaunch || !hasAnyAISource(loadedConfig.aiSources)) {
        setView('setup')
      } else {
        setView('home')
      }
    } else {
      setView('setup')
    }
  }

  // Render based on current view
  // Heavy pages (HomePage, SpacePage, SettingsPage) are lazy-loaded for better initial performance
  const renderView = () => {
    switch (view) {
      case 'splash':
        return <SplashScreen />
      case 'gitBashSetup':
        return <GitBashSetup onComplete={handleGitBashSetupComplete} />
      case 'setup':
        return <SetupFlow />
      case 'home':
        return (
          <Suspense fallback={<PageLoader />}>
            <HomePage />
          </Suspense>
        )
      case 'space':
        return (
          <Suspense fallback={<PageLoader />}>
            <SpacePage />
          </Suspense>
        )
      case 'settings':
        return (
          <Suspense fallback={<PageLoader />}>
            <SettingsPage />
          </Suspense>
        )
      default:
        return <SplashScreen />
    }
  }

  return (
    <div className="h-full w-full overflow-hidden bg-background">
      {renderView()}
      {/* Search panel - full screen edit mode */}
      <SearchPanel isOpen={isSearchOpen} onClose={closeSearch} />
      {/* Search highlight bar - floating navigation mode */}
      <SearchHighlightBar />
      {/* Onboarding overlay - renders on top of everything */}
      <OnboardingOverlay />
      {/* Update notification - shows when update is downloaded */}
      <UpdateNotification />
    </div>
  )
}
