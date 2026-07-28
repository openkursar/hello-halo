/**
 * App Store - Global application state
 */

import { create } from 'zustand'
import { api } from '../api'
import { isCapacitor } from '../api/transport'
import type { HaloConfig, AppView, McpServerStatus } from '../types'
import { hasAnyAISource } from '../types'

// Git Bash installation progress
interface GitBashInstallProgress {
  phase: 'idle' | 'downloading' | 'extracting' | 'configuring' | 'done' | 'error'
  progress: number
  message: string
  error?: string
}

interface AppState {
  // View state
  view: AppView
  previousView: AppView | null  // Track previous view for back navigation
  isLoading: boolean
  error: string | null

  // Config
  config: HaloConfig | null

  // MCP Status (cached from last conversation)
  mcpStatus: McpServerStatus[]
  mcpStatusTimestamp: number | null  // When status was last updated

  // Git Bash mock mode (Windows only)
  mockBashMode: boolean
  gitBashInstallProgress: GitBashInstallProgress
  gitBashCheckPending: boolean  // True when git-bash check was deferred due to IPC not ready

  // Actions
  setView: (view: AppView) => void
  goBack: () => void  // Navigate back to previous view
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setConfig: (config: HaloConfig) => void
  updateConfig: (updates: Partial<HaloConfig>) => void
  setMcpStatus: (status: McpServerStatus[], timestamp: number) => void

  // Git Bash actions
  setMockBashMode: (mode: boolean) => void
  startGitBashInstall: () => Promise<void>
  refreshGitBashStatus: () => Promise<void>
  completeDeferredGitBashCheck: () => Promise<void>

  // Initialization
  initialize: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  view: 'splash',
  previousView: null,
  isLoading: true,
  error: null,
  config: null,
  mcpStatus: [],
  mcpStatusTimestamp: null,
  mockBashMode: false,
  gitBashInstallProgress: { phase: 'idle', progress: 0, message: '' },
  gitBashCheckPending: false,

  // Actions
  setView: (view) => {
    const currentView = get().view
    // Save current view as previous (except for transient screens)
    if (currentView !== 'splash' && currentView !== 'setup' && currentView !== 'serverConnect' && currentView !== 'serverList') {
      set({ previousView: currentView, view })
    } else {
      set({ view })
    }
  },

  goBack: () => {
    const previousView = get().previousView
    // Go back to previous view, or default to home
    set({ view: previousView || 'home', previousView: null })
  },

  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setConfig: (config) => set({ config }),

  updateConfig: (updates) => {
    const currentConfig = get().config
    if (currentConfig) {
      set({ config: { ...currentConfig, ...updates } })
    }
  },

  setMcpStatus: (status, timestamp) => {
    set({ mcpStatus: status, mcpStatusTimestamp: timestamp })
  },

  // Git Bash actions
  setMockBashMode: (mode) => set({ mockBashMode: mode }),

  startGitBashInstall: async () => {
    set({
      gitBashInstallProgress: { phase: 'downloading', progress: 0, message: 'Preparing download...' }
    })

    try {
      const result = await api.installGitBash((progressData) => {
        set({
          gitBashInstallProgress: {
            phase: progressData.phase as GitBashInstallProgress['phase'],
            progress: progressData.progress,
            message: progressData.message,
            error: progressData.error
          }
        })
      })

      if (result.success) {
        set({
          gitBashInstallProgress: { phase: 'done', progress: 100, message: 'Installation complete' }
        })
        // Refresh status after successful install
        await get().refreshGitBashStatus()
      } else {
        set({
          gitBashInstallProgress: {
            phase: 'error',
            progress: 0,
            message: 'Installation failed',
            error: result.error || 'Unknown error'
          }
        })
      }
    } catch (e) {
      set({
        gitBashInstallProgress: {
          phase: 'error',
          progress: 0,
          message: 'Installation failed',
          error: e instanceof Error ? e.message : String(e)
        }
      })
    }
  },

  refreshGitBashStatus: async () => {
    if (!window.platform?.isWindows) return

    try {
      const status = await api.getGitBashStatus()
      if (status.success && status.data) {
        const { mockMode } = status.data
        set({ mockBashMode: !!mockMode })

        // Reset install progress if no longer in mock mode
        if (!mockMode) {
          set({
            gitBashInstallProgress: { phase: 'idle', progress: 0, message: '' }
          })
        }
      }
    } catch (e) {
      console.error('[App] Failed to refresh Git Bash status:', e)
    }
  },

  // Complete a deferred Git Bash check after extended services become ready.
  // Called when bootstrap timeout fired before extended services registered IPC handlers,
  // causing the initial git-bash check to fail. Once extended-ready arrives, this
  // re-runs the check so Windows users without Git Bash still see the setup flow.
  completeDeferredGitBashCheck: async () => {
    if (!get().gitBashCheckPending) return
    if (!window.platform?.isWindows) {
      set({ gitBashCheckPending: false })
      return
    }

    console.log('[Store] Completing deferred Git Bash check...')
    try {
      const gitBashStatus = await api.getGitBashStatus()
      console.log('[Store] Deferred Git Bash status response:', gitBashStatus)
      if (gitBashStatus.success && gitBashStatus.data) {
        const { found, mockMode } = gitBashStatus.data

        if (mockMode) {
          set({ mockBashMode: true })
        }

        // Git Bash genuinely not available — redirect to setup
        if (!found && !mockMode) {
          console.log('[Store] Deferred check: Git Bash not found, showing gitBashSetup')
          set({ view: 'gitBashSetup' })
        }
      }
    } catch (e) {
      console.warn('[Store] Deferred Git Bash check failed:', e)
    } finally {
      set({ gitBashCheckPending: false })
    }
  },

  // Initialize app
  initialize: async () => {
    console.log('[Store] initialize() called')
    try {
      set({ isLoading: true, error: null })

      // Windows: Check Git Bash availability first
      // Wrapped in its own try-catch because this IPC handler lives in extended services.
      // If the bootstrap timeout fires before extended services are ready, this call
      // will fail with "No handler registered". That is NOT a reason to show the setup
      // page — the user's config/API key is unrelated to git-bash availability.
      // The check will be retried when extended-ready arrives (see completeDeferredGitBashCheck).
      if (window.platform?.isWindows) {
        console.log('[Store] Windows detected, checking Git Bash status...')
        try {
          const gitBashStatus = await api.getGitBashStatus()
          console.log('[Store] Git Bash status response:', gitBashStatus)
          if (gitBashStatus.success && gitBashStatus.data) {
            const { found, source, mockMode } = gitBashStatus.data

            // Track mock mode for showing warning banner later
            if (mockMode) {
              console.log('[Store] Git Bash in mock mode, will show warning banner')
              set({ mockBashMode: true })
            }

            // If Git Bash not found and not previously configured, show setup
            if (!found && !mockMode) {
              console.log('[Store] Git Bash not found, showing setup')
              set({ view: 'gitBashSetup', isLoading: false })
              return
            }

            console.log('[Store] Git Bash found:', source, mockMode ? '(mock mode)' : '')
          }
        } catch (gitBashError) {
          // IPC handler not registered yet (extended services not ready).
          // Mark as pending so the check runs once extended-ready arrives.
          console.warn('[Store] Git Bash check deferred (IPC not ready):', gitBashError)
          set({ gitBashCheckPending: true })
        }
      }

      // Load config from main process
      // config:get handler is registered in Essential services, so this always works.
      console.log('[Store] Loading config...')
      const response = await api.getConfig()
      console.log('[Store] Config response:', response.success ? 'success' : 'failed')

      if (response.success && response.data) {
        const config = response.data as HaloConfig

        set({ config })

        // Determine initial view based on config
        // Show setup if first launch or no AI source configured (OAuth or Custom API).
        // modelConfigSkipped honors a user's explicit deferral from the first-run wizard.
        if (config.isFirstLaunch || (!hasAnyAISource(config.aiSources) && !config.modelConfigSkipped)) {
          console.log('[Store] First launch or no AI source, showing setup')
          set({ view: 'setup' })
        } else {
          // Go to home
          console.log('[Store] Config loaded, showing home')
          set({ view: 'home' })

          // Silently refresh remote model lists in background (fire-and-forget).
          // Ensures users see the latest available models without manual refresh,
          // e.g. after provider adds new models or app is reinstalled.
          api.refreshAISourcesConfig().then(result => {
            if (result.success && result.data) {
              const current = get().config
              if (current) {
                set({ config: { ...current, aiSources: (result.data as any).aiSources } })
                console.log('[Store] Startup model refresh complete')
              }
            }
          }).catch(() => {
            // Network unavailable — acceptable, user can refresh manually
          })
        }
      } else {
        console.error('[Store] Failed to load config:', response.error)
        // Capacitor: config load failure means server connection lost → go to server list
        if (isCapacitor()) {
          console.log('[Store] Capacitor mode: config load failed, showing server list')
          set({ view: 'serverList' })
        } else {
          set({ error: response.error || 'Failed to load configuration' })
          set({ view: 'setup' })
        }
      }
    } catch (error) {
      console.error('[Store] Failed to initialize:', error)
      if (isCapacitor()) {
        console.log('[Store] Capacitor mode: init error, showing server list')
        set({ view: 'serverList' })
      } else {
        set({ error: 'Failed to initialize application' })
        set({ view: 'setup' })
      }
    } finally {
      set({ isLoading: false })
      console.log('[Store] initialize() completed')
    }
  }
}))
