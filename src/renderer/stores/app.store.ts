/**
 * App Store - Global application state
 */

import { create } from 'zustand'
import { api } from '../api'
import type { HaloConfig, AppView, McpServerStatus } from '../types'

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

  // Actions
  setView: (view) => {
    const currentView = get().view
    // Save current view as previous (except for splash and setup screens)
    if (currentView !== 'splash' && currentView !== 'setup') {
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

  // Initialize app
  initialize: async () => {
    try {
      set({ isLoading: true, error: null })

      // Windows: Check Git Bash availability first
      if (window.platform?.isWindows) {
        const gitBashStatus = await api.getGitBashStatus()
        if (gitBashStatus.success && gitBashStatus.data) {
          const { found, source, mockMode } = gitBashStatus.data

          // Track mock mode for showing warning banner later
          if (mockMode) {
            console.log('[App] Git Bash in mock mode, will show warning banner')
            set({ mockBashMode: true })
          }

          // If Git Bash not found and not previously configured, show setup
          if (!found && !mockMode) {
            console.log('[App] Git Bash not found, showing setup')
            set({ view: 'gitBashSetup', isLoading: false })
            return
          }

          console.log('[App] Git Bash found:', source, mockMode ? '(mock mode)' : '')
        }
      }

      // Load config from main process
      const response = await api.getConfig()

      if (response.success && response.data) {
        const config = response.data as HaloConfig

        set({ config })

        // Determine initial view based on config
        if (config.isFirstLaunch || !config.api.apiKey) {
          // Show setup if first launch or no API key
          set({ view: 'setup' })
        } else {
          // Go to home
          set({ view: 'home' })
        }
      } else {
        set({ error: response.error || 'Failed to load configuration' })
        set({ view: 'setup' })
      }
    } catch (error) {
      console.error('Failed to initialize:', error)
      set({ error: 'Failed to initialize application' })
      set({ view: 'setup' })
    } finally {
      set({ isLoading: false })
    }
  }
}))
