/**
 * systemApi — system domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const systemApi = {
  // ===== Onboarding =====
  writeOnboardingArtifact: async (
    spaceId: string,
    fileName: string,
    content: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.writeOnboardingArtifact(spaceId, fileName, content)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/onboarding/artifact`, { fileName, content })
  },

  saveOnboardingConversation: async (
    spaceId: string,
    userMessage: string,
    aiResponse: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.saveOnboardingConversation(spaceId, userMessage, aiResponse)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/onboarding/conversation`, { userMessage, aiResponse })
  },

  // ===== System Settings (Electron only) =====
  getAutoLaunch: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getAutoLaunch()
  },

  setAutoLaunch: async (enabled: boolean): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.setAutoLaunch(enabled)
  },

  openLogFolder: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.openLogFolder()
  },

  relaunch: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.relaunch()
  },

  // ===== Window (Electron only) =====
  setTitleBarOverlay: async (options: {
    color: string
    symbolColor: string
  }): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: true } // No-op in remote mode
    }
    return window.halo.setTitleBarOverlay(options)
  },

  maximizeWindow: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.maximizeWindow()
  },

  unmaximizeWindow: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.unmaximizeWindow()
  },

  isWindowMaximized: async (): Promise<ApiResponse<boolean>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.isWindowMaximized()
  },

  toggleMaximizeWindow: async (): Promise<ApiResponse<boolean>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.toggleMaximizeWindow()
  },

  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void) => {
    if (!isElectron()) {
      return () => { } // No-op in remote mode
    }
    return window.halo.onWindowMaximizeChange(callback)
  },

  // ===== Overlay (Electron only) =====
  // Used for floating UI elements that need to render above BrowserViews
  showChatCapsuleOverlay: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.showChatCapsuleOverlay()
  },

  hideChatCapsuleOverlay: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.hideChatCapsuleOverlay()
  },

  onCanvasExitMaximized: (callback: () => void) => {
    if (!isElectron()) {
      return () => { } // No-op in remote mode
    }
    return window.halo.onCanvasExitMaximized(callback)
  },

  // ===== Git Bash (Windows only, Electron only) =====
  getGitBashStatus: async (): Promise<ApiResponse<{
    found: boolean
    path: string | null
    source: 'system' | 'app-local' | 'env-var' | 'mock' | null
    mockMode?: boolean
  }>> => {
    if (!isElectron()) {
      // In remote mode, assume Git Bash is available (server handles it)
      return { success: true, data: { found: true, path: null, source: null, mockMode: false } }
    }
    return window.halo.getGitBashStatus()
  },

  installGitBash: async (onProgress: (progress: {
    phase: 'downloading' | 'extracting' | 'configuring' | 'done' | 'error'
    progress: number
    message: string
    error?: string
  }) => void): Promise<{ success: boolean; path?: string; error?: string }> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.installGitBash(onProgress)
  },

  openLoginWindow: async (url: string, title?: string): Promise<ApiResponse> => {
    if (!isElectron()) {
      // In remote mode, open in new tab
      window.open(url, '_blank')
      return { success: true }
    }
    return window.halo.openLoginWindow(url, title)
  },

  openExternal: async (url: string): Promise<void> => {
    if (!isElectron()) {
      // In remote mode, open in new tab
      window.open(url, '_blank')
      return
    }
    return window.halo.openExternal(url)
  },

  // ===== Bootstrap Lifecycle (Electron only) =====
  // Used to coordinate renderer initialization with main process service registration.
  // Implements Pull+Push pattern for reliable initialization:
  // - Pull: getBootstrapStatus() for immediate state query (handles HMR, error recovery)
  // - Push: onBootstrapExtendedReady() for event-based notification (normal startup)

  getBootstrapStatus: async (): Promise<{
    extendedReady: boolean
    extendedReadyAt: number
  }> => {
    if (!isElectron()) {
      // In remote mode, services are always ready (server handles it)
      return { extendedReady: true, extendedReadyAt: Date.now() }
    }
    const result = await window.halo.getBootstrapStatus()
    return result.data ?? { extendedReady: false, extendedReadyAt: 0 }
  },

  onBootstrapExtendedReady: (callback: (data: { timestamp: number; duration: number }) => void) => {
    if (!isElectron()) {
      // In remote mode, services are always ready (server handles it)
      // Call callback immediately
      setTimeout(() => callback({ timestamp: Date.now(), duration: 0 }), 0)
      return () => {}
    }
    return window.halo.onBootstrapExtendedReady(callback)
  },

}
