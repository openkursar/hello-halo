/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Halo - Main App Component
 */

import { useEffect, useRef, useState, useCallback, Suspense, lazy } from 'react'
import { useAppStore } from './stores/app.store'
import { useChatStore } from './stores/chat.store'
import { useOnboardingStore } from './stores/onboarding.store'
import { initAIBrowserStoreListeners } from './stores/ai-browser.store'
import { initPerfStoreListeners } from './stores/perf.store'
import { useSpaceStore } from './stores/space.store'
import { useSearchStore } from './stores/search.store'
import { useAppsStore } from './stores/apps.store'
import { useAppsPageStore } from './stores/apps-page.store'
import { useTlonStore } from './stores/tlon.store'
import { SplashPage } from './pages/SplashPage'
import { SetupPage } from './pages/SetupPage'
import { GitBashSetupPage } from './pages/GitBashSetupPage'
import { ServerConnectPage } from './pages/ServerConnectPage'
import type { ServerAddedInfo } from './pages/ServerConnectPage'
import { ServerListPage } from './pages/ServerListPage'
import { useServerStore } from './stores/server.store'
import type { ServerEntry } from './stores/server.store'
import { clearPendingServerUrl, setAuthToken } from './api/transport'
import { SearchPanel } from './components/search/SearchPanel'
import { SearchHighlightBar } from './components/search/SearchHighlightBar'
import { OnboardingOverlay } from './components/onboarding'
import { UpdateNotification } from './components/updater/UpdateNotification'
import { NotificationToast } from './components/notification/NotificationToast'
import { useNotificationStore } from './stores/notification.store'
import { api } from './api'
import { syncStatusBarStyle } from './api/safe-area'
import { isCapacitor, isElectron, onEvent } from './api/transport'
import { useTelemetry } from './hooks/useTelemetry'
import type { WsConnectionState } from './api/transport'
import { useTranslation } from './i18n'
import type { AgentEventBase, Thought, ToolCall, HaloConfig, AgentErrorType, Question, McpServerStatus } from './types'
import type { SessionInitInfo } from './types/slash-command'
import type { IngestProgressEvent } from '../shared/types/tlon'
import { hasAnyAISource } from './types'

// Lazy load heavy page components for better initial load performance
// These pages contain complex components (chat, markdown, code highlighting, etc.)
const HomePage = lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })))
const SpacePage = lazy(() => import('./pages/SpacePage').then(m => ({ default: m.SpacePage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })))
const AppsPage = lazy(() => import('./pages/AppsPage').then(m => ({ default: m.AppsPage })))
const TlonPage = lazy(() => import('./pages/TlonPage').then(m => ({ default: m.TlonPage })))

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
  const { t } = useTranslation()
  const { view, config, initialize, setMcpStatus, setView, setConfig, completeDeferredGitBashCheck } = useAppStore()
  const {
    handleAgentMessage,
    handleAgentToolCall,
    handleAgentToolResult,
    handleAgentError,
    handleAgentComplete,
    handleAgentThought,
    handleAgentThoughtDelta,
    handleAgentCompact,
    handleAgentSessionInfo,
    handleAgentTurnStart,
    handleAskQuestion,
    currentSpaceId,
    setCurrentSpace: setChatCurrentSpace,
    loadConversations,
    selectConversation
  } = useChatStore()
  const { initialize: initializeOnboarding } = useOnboardingStore()
  const { isSearchOpen, closeSearch, isHighlightBarVisible, hideHighlightBar, goToPreviousResult, goToNextResult, openSearch } = useSearchStore()

  // Telemetry: session lifecycle + page views (fire-and-forget)
  useTelemetry(view)

  // Apps system real-time event handlers — accessed via getState() inside
  // useEffect so the listener refs stay stable and never re-subscribe.
  const { setInitialAppId } = useAppsPageStore()

  // For search result navigation
  const { spaces, haloSpace, setCurrentSpace: setSpaceStoreCurrentSpace, refreshCurrentSpace } = useSpaceStore()

  // Initialize app on mount - wait for backend extended services to be ready
  // Uses Pull+Push pattern for reliable initialization:
  // - Pull: Query status immediately (handles HMR, error recovery - 0ms delay)
  // - Push: Listen for event (normal startup flow)
  // - Timeout: Fallback protection if something goes wrong
  useEffect(() => {
    // Capacitor mode: skip Electron bootstrap flow entirely.
    // Initialization is triggered after the user selects a server from the list.
    if (isCapacitor()) {
      // Hydrate server store first — this pushes active URL + token to transport
      useServerStore.getState().hydrate()
      const savedUrl = api.restoreServerUrl()
      const hasToken = api.isAuthenticated()
      if (savedUrl && hasToken) {
        // Has saved connection — try to initialize immediately
        console.log('[App] Capacitor: saved connection found, initializing...')
        initialize().then(() => initializeOnboarding())
      } else {
        // No saved connection — check if we have servers in the list
        const { servers } = useServerStore.getState()
        if (servers.length > 0) {
          console.log('[App] Capacitor: servers exist but no active, showing server list')
          setView('serverList')
        } else {
          console.log('[App] Capacitor: no servers, showing ServerConnect')
          setView('serverConnect')
        }
      }
      return
    }

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
      if (!initialized) {
        // Normal path: extended services ready before timeout
        doInit('event')
      } else {
        // Timeout already fired and initialize() ran. Extended services are now ready,
        // so complete any deferred checks (e.g. git-bash on Windows) that failed
        // because IPC handlers weren't registered yet during the timeout-triggered init.
        console.log('[App] Extended ready after timeout, completing deferred checks...')
        completeDeferredGitBashCheck()
      }
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
  }, [initialize, initializeOnboarding, completeDeferredGitBashCheck, setView])

  // Theme switching
  useEffect(() => {
    // Default to 'dark' before config loads, then use config value
    const theme = config?.appearance?.theme || 'dark'
    applyTheme(theme)

    // Resolve effective dark/light for the status bar.
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const isDark = theme === 'dark' || (theme === 'system' && systemPrefersDark)

    // Sync status bar style with theme (Capacitor mobile only). No-op elsewhere.
    void syncStatusBarStyle(isDark)

    // Listen for system theme changes when using 'system' mode
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const handleChange = () => {
        applyTheme('system')
        void syncStatusBarStyle(mediaQuery.matches)
      }
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }
  }, [config?.appearance?.theme])

  // WebSocket connection state for reconnection banner
  const [wsState, setWsState] = useState<WsConnectionState>('connected')

  // Connect WebSocket for remote / Capacitor mode
  useEffect(() => {
    if (api.isRemoteMode() || api.isCapacitorMode()) {
      console.log('[App] Remote/Capacitor mode detected, connecting WebSocket...')
      api.connectWebSocket()
    }
  }, [])

  // Track WebSocket connection state for reconnection banner (remote/Capacitor only)
  useEffect(() => {
    if (!api.isRemoteMode() && !api.isCapacitorMode()) return
    const unsub = api.onWsStateChange((state: WsConnectionState) => {
      setWsState(state)
    })
    return unsub
  }, [])

  // (Capacitor auto-connect logic is merged into the main init useEffect above)

  // Capacitor: listen for auth-expired DOM events (from transport.ts 401 handler)
  useEffect(() => {
    if (!isCapacitor()) return

    const handleAuthExpired = () => {
      console.log('[App] Auth expired, navigating to server list')
      api.disconnectWebSocket()
      useServerStore.getState().clearActive()
      const { servers } = useServerStore.getState()
      setView(servers.length > 0 ? 'serverList' : 'serverConnect')
    }

    window.addEventListener('halo:auth-expired', handleAuthExpired)
    return () => window.removeEventListener('halo:auth-expired', handleAuthExpired)
  }, [setView])

  // Capacitor: notification bridge — push local notifications when app is backgrounded
  useEffect(() => {
    if (!isCapacitor()) return

    // Dynamically import Capacitor local notifications (tree-shaken in non-Capacitor builds)
    let cleanups: (() => void)[] = []

    import('@capacitor/local-notifications').then(({ LocalNotifications }) => {
      // Request notification permission
      LocalNotifications.requestPermissions().then(perm => {
        console.log('[App] Notification permission:', perm.display)
      })

      // Bridge: when WebSocket events arrive and app is hidden, fire local notification
      const notifyChannels = ['agent:complete', 'app:status_changed', 'app:escalation:new']
      for (const channel of notifyChannels) {
        const unsub = api.onEvent(channel, (data: unknown) => {
          if (!document.hidden) return // Only notify when app is backgrounded

          const event = data as Record<string, unknown>
          let title = 'Halo'
          let body = ''

          if (channel === 'agent:complete') {
            title = t('Task Complete')
            body = t('Your AI task has finished.')
          } else if (channel === 'app:status_changed') {
            const status = (event.state as Record<string, unknown>)?.status
            if (status === 'completed') {
              title = t('App Complete')
              body = t('A digital human has finished running.')
            } else {
              return // Don't notify for other status changes
            }
          } else if (channel === 'app:escalation:new') {
            title = t('Action Required')
            body = (event.question as string) || t('A digital human needs your input.')
          }

          LocalNotifications.schedule({
            notifications: [{
              id: Date.now(),
              title,
              body,
              schedule: { at: new Date() }
            }]
          }).catch(err => {
            console.warn('[App] Failed to schedule notification:', err)
          })
        })
        cleanups.push(unsub)
      }
    }).catch(err => {
      console.warn('[App] LocalNotifications not available:', err)
    })

    return () => {
      for (const fn of cleanups) fn()
    }
  }, [t])

  // Mobile/Remote: recover WebSocket + UI state when app returns to foreground
  // Handles both browser visibilitychange and Capacitor appStateChange events.
  // When the app goes to background on Android, the WebView is suspended and the
  // WebSocket connection may drop. Events (agent:complete, etc.) sent during this
  // time are lost. This effect:
  //   1. Forces immediate WebSocket reconnection (skip backoff)
  //   2. Checks each active session against the backend (getSessionState)
  //   3. If the backend says "not active" but the frontend still has isGenerating=true,
  //      triggers handleAgentComplete to unblock the UI and reload the conversation.
  useEffect(() => {
    if (isElectron()) return // Electron uses IPC, not WebSocket — no recovery needed

    const recoverOnResume = () => {
      if (document.hidden) return // Only recover when becoming visible
      console.log('[App] Visibility resumed — recovering WebSocket + session state')

      // 1. Force-reconnect WebSocket immediately (resets backoff, re-subscribes)
      api.forceReconnectWebSocket()

      // 2. Check all sessions that think they're still generating
      const chatState = useChatStore.getState()
      const sessions = chatState.sessions
      for (const [conversationId, session] of sessions) {
        if (!session.isGenerating) continue

        // Find spaceId for this conversation (virtual IDs like "app-chat:*" won't match)
        let spaceId: string | null = null
        for (const [sid, ss] of chatState.spaceStates) {
          if (ss.conversations.some(c => c.id === conversationId)) {
            spaceId = sid
            break
          }
        }

        // Ask the backend if this session is actually still active
        api.getSessionState(conversationId).then(res => {
          if (res.success && res.data) {
            const backendState = res.data as { isActive: boolean }
            if (!backendState.isActive) {
              console.log(`[App] Session ${conversationId} completed while backgrounded — recovering`)

              if (spaceId) {
                // Normal conversation — full reload via handleAgentComplete
                chatState.handleAgentComplete({ spaceId, conversationId } as AgentEventBase)
              } else {
                // Virtual conversationId (app-chat:*, im-session, etc.) — no space conversation
                // to reload. Clear session state directly to unblock the UI; the owning component
                // (AppChatView / ImChatView) will reload messages via its own isGenerating effect.
                chatState.resetSession(conversationId)
              }
            }
          }
        }).catch(err => {
          console.warn(`[App] Failed to check session state for ${conversationId}:`, err)
        })
      }
    }

    // Browser visibilitychange — works for both remote web and Capacitor WebView
    document.addEventListener('visibilitychange', recoverOnResume)

    // Capacitor appStateChange — fires reliably when Android app goes to/from background
    let removeCapListener: (() => void) | null = null
    if (isCapacitor()) {
      import('@capacitor/app').then(({ App: CapApp }) => {
        const listenerPromise = CapApp.addListener('appStateChange', (state) => {
          if (state.isActive) {
            console.log('[App] Capacitor appStateChange: active — triggering recovery')
            recoverOnResume()
          }
        })
        removeCapListener = () => { listenerPromise.then(l => l.remove()) }
      }).catch(() => {})
    }

    return () => {
      document.removeEventListener('visibilitychange', recoverOnResume)
      removeCapListener?.()
    }
  }, [])

  // Capacitor: handle Android back button
  useEffect(() => {
    if (!isCapacitor()) return

    // `cancelled` guards the race where cleanup fires before the dynamic
    // import resolves.  `removeListener` holds the teardown once resolved,
    // so the useEffect cleanup can call it synchronously.
    let cancelled = false
    let removeListener: (() => void) | null = null

    import('@capacitor/app').then(({ App: CapApp }) => {
      if (cancelled) return

      const listenerPromise = CapApp.addListener('backButton', () => {
        const currentView = useAppStore.getState().view
        if (currentView === 'settings' || currentView === 'apps') {
          useAppStore.getState().goBack()
        } else if (currentView === 'serverConnect') {
          // Back from add-server → server list (if we have servers)
          const { servers } = useServerStore.getState()
          if (servers.length > 0) {
            useAppStore.getState().setView('serverList')
          }
        }
        // On home/space/serverList: don't exit — Android will minimize the app
      })

      removeListener = () => { listenerPromise.then(l => l.remove()) }
    }).catch(() => {})

    return () => {
      cancelled = true
      removeListener?.()
    }
  }, [])

  // Handle new server added from ServerConnect (Capacitor)
  const handleServerAdded = useCallback(async (info: ServerAddedInfo) => {
    console.log(`[App] Server added: ${info.name} (${info.url})`)
    // Persist to server store
    const entry = useServerStore.getState().addServer({
      name: info.name,
      url: info.url,
      token: info.token,
    })
    // Clear the pending URL now that it's persisted
    clearPendingServerUrl()
    // Sync auth token
    setAuthToken(info.token)
    // Initialize the app
    await initialize()
    await initializeOnboarding()
  }, [initialize, initializeOnboarding])

  // Handle server selected from ServerList (Capacitor)
  const handleServerSelected = useCallback(async (server: ServerEntry) => {
    console.log(`[App] Server selected: ${server.name} (${server.url})`)
    await initialize()
    await initializeOnboarding()
  }, [initialize, initializeOnboarding])

  // Handle "Add Device" from ServerList (Capacitor)
  const handleAddServer = useCallback(() => {
    setView('serverConnect')
  }, [setView])

  // Handle back from ServerConnect to ServerList (Capacitor)
  const handleServerConnectBack = useCallback(() => {
    api.clearServerUrl() // Clear pending URL
    setView('serverList')
  }, [setView])

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
      const _d = data as AgentEventBase & { thought: Thought }
      console.log(`[App][+${Date.now() % 100000}ms] Received agent:thought: type=${_d.thought?.type} id=${_d.thought?.id}`)
      handleAgentThought(_d)
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
      const _m = data as AgentEventBase & { content?: string; delta?: string; isComplete?: boolean; isNewTextBlock?: boolean }
      if (_m.isComplete || _m.isNewTextBlock) {
        console.log(`[App][+${Date.now() % 100000}ms] agent:message: isComplete=${_m.isComplete} isNewTextBlock=${_m.isNewTextBlock} contentLen=${(_m.content ?? '').length}`)
      }
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
      console.log(`[App][+${Date.now() % 100000}ms] Received agent:complete event:`, data)
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

    // Session info from SDK system:init — slash_commands / skills / agents for autocomplete
    const unsubSessionInfo = api.onAgentSessionInfo((data) => {
      handleAgentSessionInfo(data as AgentEventBase & SessionInitInfo)
    })

    // Autonomous turn start — CC produced output without user send (e.g., Agent Team)
    const unsubTurnStart = api.onAgentTurnStart((data) => {
      console.log('[App] Received agent:turn-start event:', data)
      handleAgentTurnStart(data as AgentEventBase & { autonomous?: boolean })
    })

    // MCP status updates (global - not per-conversation)
    const unsubMcpStatus = api.onAgentMcpStatus((data) => {
      console.log('[App] Received agent:mcp-status event:', data)
      const event = data as { servers: McpServerStatus[]; timestamp: number }
      if (event.servers) {
        setMcpStatus(event.servers, event.timestamp)
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
      unsubSessionInfo()
      unsubTurnStart()
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
    handleAgentSessionInfo,
    handleAgentTurnStart,
    handleAskQuestion,
    setMcpStatus
  ])

  // Register Apps system real-time event listeners
  // These run globally so events are captured even when AppsPage is not mounted
  useEffect(() => {
    console.log('[App] Registering app event listeners')

    const unsubStatus = api.onAppStatusChanged((data) => {
      const { appId, state } = data as { appId: string; state: unknown }
      useAppsStore.getState().handleStatusChanged(appId, state as any)
    })

    const unsubActivity = api.onAppActivityEntry((data) => {
      const { appId, entry } = data as { appId: string; entry: unknown }
      useAppsStore.getState().handleNewActivityEntry(appId, entry as any)
    })

    const unsubEscalation = api.onAppEscalation((data) => {
      const { appId, entryId, question, choices } = data as {
        appId: string; entryId: string; question: string; choices: string[]
      }
      useAppsStore.getState().handleNewEscalation(appId, entryId, question, choices)
    })

    // Deep navigation: notification click → navigate to specific App's Activity Thread
    const unsubNavigate = api.onAppNavigate((data) => {
      const { appId } = data as { appId: string }
      if (appId) {
        console.log(`[App] Notification deep navigation: appId=${appId}`)
        setInitialAppId(appId)
        setView('apps')
      }
    })

    return () => {
      unsubStatus()
      unsubActivity()
      unsubEscalation()
      unsubNavigate()
    }
  }, [setInitialAppId, setView])

  // Register Tlon (knowledge base) real-time event listeners.
  // Uses the imported onEvent() transport directly (not api.onEvent) so the
  // channel mapping in transport.ts methodMap is honored. Progress events
  // drive animation only; the store re-pulls authoritative status from disk.
  useEffect(() => {
    const unsubProgress = onEvent('tlon:ingest-progress', (data) => {
      useTlonStore.getState().handleIngestProgress(data as IngestProgressEvent)
    })
    const unsubStats = onEvent('tlon:stats-updated', (data) => {
      const { kbId } = data as { kbId: string }
      if (kbId) useTlonStore.getState().handleStatsUpdated(kbId)
    })
    return () => {
      unsubProgress()
      unsubStats()
    }
  }, [])

  // Register in-app toast listener (notification:toast from main process)
  const showToast = useNotificationStore((s) => s.show)
  useEffect(() => {
    const unsub = api.onNotificationToast((data) => {
      const { title, body, variant, duration, appId } = data as {
        title: string; body?: string; variant?: 'default' | 'success' | 'warning' | 'error'; duration?: number; appId?: string
      }
      showToast({
        title,
        body,
        variant: variant ?? 'default',
        duration: duration ?? 6000,
        // If appId is provided, add a "View" action for deep navigation
        ...(appId ? {
          action: {
            label: t('View'),
            onClick: () => {
              setInitialAppId(appId)
              setView('apps')
            },
          },
        } : {}),
      })
    })
    return () => { unsub() }
  }, [showToast, setInitialAppId, setView, t])

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
          refreshCurrentSpace()  // Load full space data (preferences) from backend

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
  }, [currentSpaceId, spaces, haloSpace, setSpaceStoreCurrentSpace, refreshCurrentSpace, setChatCurrentSpace, loadConversations, selectConversation])

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

  // Show reconnection banner for remote/Capacitor modes
  const showReconnectBanner = (api.isRemoteMode() || api.isCapacitorMode())
    && wsState !== 'connected'
    && view !== 'serverConnect'
    && view !== 'serverList'
    && view !== 'splash'

  // Render based on current view
  // Heavy pages (HomePage, SpacePage, SettingsPage) are lazy-loaded for better initial performance
  const renderView = () => {
    switch (view) {
      case 'splash':
        return <SplashPage />
      case 'gitBashSetup':
        return <GitBashSetupPage onComplete={handleGitBashSetupComplete} />
      case 'setup':
        return <SetupPage />
      case 'serverConnect':
        return (
          <ServerConnectPage
            onServerAdded={handleServerAdded}
            onBack={useServerStore.getState().servers.length > 0 ? handleServerConnectBack : undefined}
          />
        )
      case 'serverList':
        return (
          <ServerListPage
            onServerSelected={handleServerSelected}
            onAddServer={handleAddServer}
          />
        )
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
      case 'apps':
        return (
          <Suspense fallback={<PageLoader />}>
            <AppsPage />
          </Suspense>
        )
      case 'tlon':
        return (
          <Suspense fallback={<PageLoader />}>
            <TlonPage />
          </Suspense>
        )
      default:
        return <SplashPage />
    }
  }

  return (
    <div className="h-full w-full overflow-hidden bg-background">
      {/* WebSocket reconnection banner */}
      {showReconnectBanner && (
        <div className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2 py-1.5 bg-halo-warning/90 text-sm font-medium animate-slide-down safe-area-top"
          style={{ paddingTop: 'max(6px, var(--sat))' }}
        >
          <div className="w-3 h-3 border-2 border-foreground/60 border-t-foreground rounded-full animate-spin" />
          <span className="text-foreground">{t('Reconnecting...')}</span>
        </div>
      )}
      {renderView()}
      {/* Search panel - full screen edit mode */}
      <SearchPanel isOpen={isSearchOpen} onClose={closeSearch} />
      {/* Search highlight bar - floating navigation mode */}
      <SearchHighlightBar />
      {/* Onboarding overlay - renders on top of everything */}
      <OnboardingOverlay />
      {/* Update notification listener - pushes toasts into notification store */}
      <UpdateNotification />
      {/* Unified in-app toast notifications */}
      <NotificationToast />
    </div>
  )
}
