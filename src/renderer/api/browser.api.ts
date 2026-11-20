import type { RpcClient } from '../../shared/rpc/define'
import type { browserRpc } from '../../shared/rpc/contracts/browser.contract'
import type { BrowserPageGone, BrowserTabOpened } from '../../shared/types/browser-host'
import { ensureExtendedServicesReady } from './bootstrap-ready'
/**
 * browserApi — browser domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
  onEvent,
  sendWsMessage,
  supportsBrowserLive,
  supportsBrowserCredentials,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'
import type {
  AIBrowserActiveView,
  AIBrowserConversationReleased,
  AIBrowserCredentialRequest,
  AIBrowserCredentialResolved,
  AIBrowserLivePage,
  AIBrowserOperating,
  AIBrowserPageOpened,
  AIBrowserStopResult,
  AIBrowserViewGone,
} from '../../shared/types/ai-browser'
import type { BrowserLiveDetailScope, BrowserLiveFrame, BrowserLiveInput, BrowserLiveStopped } from '../../shared/types/browser-live'

export const browserApi = {
  clearBrowserData: (async () => {
    if (!isElectron()) return { success: false, error: 'Only available in desktop app' }
    return window.halo.clearBrowserData()
  }) satisfies RpcClient<typeof browserRpc>['clearBrowserData'],

  // ===== Browser (Embedded Browser for Content Canvas) =====
  // Note: Browser features only available in desktop app (not remote mode)

  getBrowserHomepage: async (): Promise<string> => {
    if (isElectron()) {
      const result = await window.halo.getBrowserHomepage()
      if (result.success) return result.data as string
    }
    return 'https://www.bing.com'
  },

  createBrowserView: async (viewId: string, url?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.createBrowserView(viewId, url)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  destroyBrowserView: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.destroyBrowserView(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  showBrowserView: async (
    viewId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.showBrowserView(viewId, bounds)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  hideBrowserView: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.hideBrowserView(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  resizeBrowserView: async (
    viewId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.resizeBrowserView(viewId, bounds)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  navigateBrowserView: async (viewId: string, url: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.navigateBrowserView(viewId, url)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  browserGoBack: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.browserGoBack(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  browserGoForward: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.browserGoForward(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  browserReload: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.browserReload(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  browserStop: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.browserStop(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  getBrowserState: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getBrowserState(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  captureBrowserView: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.captureBrowserView(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  executeBrowserJS: async (viewId: string, code: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.executeBrowserJS(viewId, code)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  setBrowserZoom: async (viewId: string, level: number): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.setBrowserZoom(viewId, level)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  toggleBrowserDevTools: async (viewId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.toggleBrowserDevTools(viewId)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  setBrowserDeviceMode: async (viewId: string, mode: 'pc' | 'h5'): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.setBrowserDeviceMode(viewId, mode)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  showBrowserContextMenu: async (options: { viewId: string; url?: string; zoomLevel: number }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.showBrowserContextMenu(options)
    }
    return { success: false, error: 'Browser views only available in desktop app' }
  },

  onBrowserStateChange: (callback: (data: unknown) => void) =>
    onEvent('browser:state-change', callback),

  onBrowserPageGone: (callback: (data: BrowserPageGone) => void) =>
    onEvent('browser:page-gone', callback as (data: unknown) => void),

  onBrowserTabOpened: (callback: (data: BrowserTabOpened) => void) =>
    onEvent('browser:tab-opened', callback as (data: unknown) => void),

  onBrowserZoomChanged: (callback: (data: { viewId: string; zoomLevel: number }) => void) =>
    onEvent('browser:zoom-changed', callback as (data: unknown) => void),

  // Canvas Tab Context Menu (native Electron menu)
  showCanvasTabContextMenu: async (options: {
    tabId: string
    tabIndex: number
    tabTitle: string
    tabPath?: string
    tabCount: number
    hasTabsToRight: boolean
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.showCanvasTabContextMenu(options)
    }
    return { success: false, error: 'Native menu only available in desktop app' }
  },

  onCanvasTabAction: (callback: (data: {
    action: 'close' | 'closeOthers' | 'closeToRight' | 'copyPath' | 'refresh'
    tabId?: string
    tabIndex?: number
    tabPath?: string
  }) => void) =>
    onEvent('canvas:tab-action', callback as (data: unknown) => void),

  // AI Browser active view change notification
  // Sent when a conversation's AI browser tools create or select a view
  onAIBrowserActiveViewChanged: (callback: (data: AIBrowserActiveView) => void) =>
    onEvent('ai-browser:active-view-changed', callback as (data: unknown) => void),

  onAIBrowserPageOpened: (callback: (data: AIBrowserPageOpened) => void) =>
    onEvent('ai-browser:page-opened', callback as (data: unknown) => void),

  // AI Browser view-gone notification
  // Sent when an AI-driven view is destroyed (canvas tab close, session end)
  onAIBrowserViewGone: (callback: (data: AIBrowserViewGone) => void) =>
    onEvent('ai-browser:view-gone', callback as (data: unknown) => void),

  // A conversation's browser context ended; it no longer holds any page
  onAIBrowserConversationReleased: (callback: (data: AIBrowserConversationReleased) => void) =>
    onEvent('ai-browser:conversation-released', callback as (data: unknown) => void),

  // A conversation's AI started or stopped operating its browser
  onAIBrowserOperating: (callback: (data: AIBrowserOperating) => void) =>
    onEvent('ai-browser:operating', callback as (data: unknown) => void),

  // The user closes an AI page: main refuses unless the page is still this
  // conversation's alone. Desktop only: remote clients do not own browser guests.
  stopAIBrowserPage: async (viewId: string, conversationId: string): Promise<AIBrowserStopResult> => {
    if (!isElectron()) return { stopped: false }
    const result = await window.halo.stopAIBrowserPage(viewId, conversationId)
    return result.success && result.data ? result.data : { stopped: false }
  },

  // Every page AI conversations hold, for a client that missed the live events
  // (reload, late connection). A server's remote clients watch them through the
  // live view; a desktop's remote clients list them as tabs they cannot display.
  listAIBrowserLivePages: async (): Promise<AIBrowserLivePage[]> => {
    if (isElectron()) await ensureExtendedServicesReady()
    const result = isElectron()
      ? await window.halo.listAIBrowserLivePages()
      : await httpRequest<AIBrowserLivePage[]>('GET', '/api/ai-browser/live-pages')
    if (!result.success || !Array.isArray(result.data)) throw new Error(result.error ?? 'Live browser pages unavailable')
    return result.data
  },

  // A page is waiting for text the model must not hold — a PIN, a one-time
  // code. Unlike the page-lifecycle calls above these work in remote mode too:
  // the person answering may not be sitting at the desktop app.
  onAIBrowserCredentialRequest: (callback: (data: AIBrowserCredentialRequest) => void) =>
    onEvent('ai-browser:credential-request', callback as (data: unknown) => void),

  // That wait ended (answered elsewhere, declined, or expired) — close the prompt
  onAIBrowserCredentialResolved: (callback: (data: AIBrowserCredentialResolved) => void) =>
    onEvent('ai-browser:credential-resolved', callback as (data: unknown) => void),

  // Requests still waiting, for a client that joined after the event
  listAIBrowserCredentialRequests: async (): Promise<AIBrowserCredentialRequest[]> => {
    if (!supportsBrowserCredentials()) return []
    const result = await httpRequest<AIBrowserCredentialRequest[]>('GET', '/api/browser/credential-requests')
    return result.success && result.data ? result.data : []
  },

  // The values go straight to the waiting page fill and are never stored
  submitAIBrowserCredential: async (requestId: string, values: Record<string, string>): Promise<ApiResponse> => {
    if (!supportsBrowserCredentials()) return { success: false }
    return httpRequest('POST', '/api/browser/credential-requests/submit', { requestId, values })
  },

  declineAIBrowserCredential: async (requestId: string): Promise<ApiResponse> => {
    if (!supportsBrowserCredentials()) return { success: false }
    return httpRequest('POST', '/api/browser/credential-requests/decline', { requestId })
  },

  supportsBrowserLive,
  supportsBrowserCredentials,

  // ===== Browser live view (remote clients only) =====
  // A client that cannot host a page watches it as paced frames instead. The
  // desktop app owns the real page and never needs this, so the control
  // messages are WebSocket-only — there is no IPC counterpart to fall back to.

  attachBrowserLive: (viewId: string): boolean =>
    sendWsMessage('browser-live-attach', { viewId }),

  detachBrowserLive: (viewId: string): void => {
    sendWsMessage('browser-live-detach', { viewId })
  },

  // Rendered up to `seq`; the stream sends the next frame only after this.
  ackBrowserLive: (viewId: string, seq: number): void => {
    sendWsMessage('browser-live-ack', { viewId, seq })
  },

  // One still outside the stream: the screen at full resolution (a QR code the
  // stream's bitrate destroys) or the whole page (to pick a spot to jump to).
  requestBrowserLiveDetail: (viewId: string, scope: BrowserLiveDetailScope = 'screen'): void => {
    sendWsMessage('browser-live-detail', { viewId, scope })
  },

  // Operate the watched page; ignored by the server unless this client is its owner.
  sendBrowserLiveInput: (viewId: string, input: BrowserLiveInput): void => {
    sendWsMessage('browser-live-input', { viewId, input })
  },

  onBrowserLiveFrame: (callback: (data: BrowserLiveFrame) => void) =>
    onEvent('browser:live-frame', callback as (data: unknown) => void),

  onBrowserLiveStopped: (callback: (data: BrowserLiveStopped) => void) =>
    onEvent('browser:live-stopped', callback as (data: unknown) => void),

  // ===== Browser Policy (user-extensible allowlist — desktop only) =====
  getBrowserPolicy: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getBrowserPolicy()
  },

  addBrowserAllowlistEntry: async (pattern: string): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.addBrowserAllowlistEntry(pattern)
  },

  removeBrowserAllowlistEntry: async (pattern: string): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.removeBrowserAllowlistEntry(pattern)
  },

}
