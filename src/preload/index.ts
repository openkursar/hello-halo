/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Preload Script - Exposes IPC to renderer
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  HealthStatusResponse,
  HealthStateResponse,
  HealthRecoveryResponse,
  HealthReportResponse,
  HealthExportResponse,
  HealthCheckResponse
} from '../shared/types'
import type { StoreInstallProgress } from '../shared/store/store-types'

// Type definitions for exposed API
export interface HaloAPI {
  // Generic Auth (provider-agnostic)
  authGetProviders: () => Promise<IpcResponse>
  authGetBuiltinProviders: () => Promise<IpcResponse>
  authStartLogin: (providerType: string) => Promise<IpcResponse>
  authCompleteLogin: (providerType: string, state: string) => Promise<IpcResponse>
  authRefreshToken: (sourceId: string) => Promise<IpcResponse>
  authCheckToken: (sourceId: string) => Promise<IpcResponse>
  authLogout: (sourceId: string) => Promise<IpcResponse>
  onAuthLoginProgress: (callback: (data: { provider: string; status: string }) => void) => () => void

  // Config
  getConfig: () => Promise<IpcResponse>
  setConfig: (updates: Record<string, unknown>) => Promise<IpcResponse>
  validateApi: (apiKey: string, apiUrl: string, provider: string) => Promise<IpcResponse>
  fetchModels: (apiKey: string, apiUrl: string) => Promise<IpcResponse>
  refreshAISourcesConfig: () => Promise<IpcResponse>

  // AI Sources CRUD (atomic - backend reads from disk, never overwrites rotating tokens)
  aiSourcesSwitchSource: (sourceId: string) => Promise<IpcResponse>
  aiSourcesSetModel: (modelId: string) => Promise<IpcResponse>
  aiSourcesAddSource: (source: unknown) => Promise<IpcResponse>
  aiSourcesUpdateSource: (sourceId: string, updates: unknown) => Promise<IpcResponse>
  aiSourcesDeleteSource: (sourceId: string) => Promise<IpcResponse>

  // Space
  getHaloSpace: () => Promise<IpcResponse>
  listSpaces: () => Promise<IpcResponse>
  createSpace: (input: { name: string; icon: string; customPath?: string }) => Promise<IpcResponse>
  deleteSpace: (spaceId: string) => Promise<IpcResponse>
  getSpace: (spaceId: string) => Promise<IpcResponse>
  openSpaceFolder: (spaceId: string) => Promise<IpcResponse>
  updateSpace: (spaceId: string, updates: { name?: string; icon?: string }) => Promise<IpcResponse>
  getDefaultSpacePath: () => Promise<IpcResponse>
  selectFolder: () => Promise<IpcResponse>
  updateSpacePreferences: (spaceId: string, preferences: {
    layout?: {
      artifactRailExpanded?: boolean
      chatWidth?: number
    }
  }) => Promise<IpcResponse>
  getSpacePreferences: (spaceId: string) => Promise<IpcResponse>

  // Conversation
  listConversations: (spaceId: string) => Promise<IpcResponse>
  createConversation: (spaceId: string, title?: string) => Promise<IpcResponse>
  getConversation: (spaceId: string, conversationId: string) => Promise<IpcResponse>
  updateConversation: (
    spaceId: string,
    conversationId: string,
    updates: Record<string, unknown>
  ) => Promise<IpcResponse>
  deleteConversation: (spaceId: string, conversationId: string) => Promise<IpcResponse>
  addMessage: (
    spaceId: string,
    conversationId: string,
    message: { role: string; content: string }
  ) => Promise<IpcResponse>
  updateLastMessage: (
    spaceId: string,
    conversationId: string,
    updates: Record<string, unknown>
  ) => Promise<IpcResponse>
  getMessageThoughts: (
    spaceId: string,
    conversationId: string,
    messageId: string
  ) => Promise<IpcResponse>
  toggleStarConversation: (
    spaceId: string,
    conversationId: string,
    starred: boolean
  ) => Promise<IpcResponse>

  // Agent
  sendMessage: (request: {
    spaceId: string
    conversationId: string
    message: string
    resumeSessionId?: string
    images?: Array<{
      id: string
      type: 'image'
      mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      data: string
      name?: string
      size?: number
    }>
    aiBrowserEnabled?: boolean  // Enable AI Browser tools
    thinkingEnabled?: boolean  // Enable extended thinking mode
    canvasContext?: {  // Canvas context for AI awareness
      isOpen: boolean
      tabCount: number
      activeTab: {
        type: string
        title: string
        url?: string
        path?: string
      } | null
      tabs: Array<{
        type: string
        title: string
        url?: string
        path?: string
        isActive: boolean
      }>
    }
  }) => Promise<IpcResponse>
  stopGeneration: (conversationId?: string) => Promise<IpcResponse>
  approveTool: (conversationId: string) => Promise<IpcResponse>
  rejectTool: (conversationId: string) => Promise<IpcResponse>
  getSessionState: (conversationId: string) => Promise<IpcResponse>
  ensureSessionWarm: (spaceId: string, conversationId: string) => Promise<IpcResponse>
  testMcpConnections: () => Promise<{ success: boolean; servers: unknown[]; error?: string }>
  answerQuestion: (data: { conversationId: string; id: string; answers: Record<string, string> }) => Promise<IpcResponse>

  // Event listeners
  onAgentMessage: (callback: (data: unknown) => void) => () => void
  onAgentToolCall: (callback: (data: unknown) => void) => () => void
  onAgentToolResult: (callback: (data: unknown) => void) => () => void
  onAgentError: (callback: (data: unknown) => void) => () => void
  onAgentComplete: (callback: (data: unknown) => void) => () => void
  onAgentThinking: (callback: (data: unknown) => void) => () => void
  onAgentThought: (callback: (data: unknown) => void) => () => void
  onAgentThoughtDelta: (callback: (data: unknown) => void) => () => void
  onAgentMcpStatus: (callback: (data: unknown) => void) => () => void
  onAgentCompact: (callback: (data: unknown) => void) => () => void
  onAgentAskQuestion: (callback: (data: unknown) => void) => () => void
  onAgentSessionInfo: (callback: (data: unknown) => void) => () => void

  // Artifact
  listArtifacts: (spaceId: string, maxDepth?: number) => Promise<IpcResponse>
  listArtifactsTree: (spaceId: string) => Promise<IpcResponse>
  loadArtifactChildren: (spaceId: string, dirPath: string) => Promise<IpcResponse>
  initArtifactWatcher: (spaceId: string) => Promise<IpcResponse>
  onArtifactChanged: (callback: (data: {
    type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
    path: string
    relativePath: string
    spaceId: string
    item?: unknown
  }) => void) => () => void
  onArtifactTreeUpdate: (callback: (data: {
    spaceId: string
    updatedDirs: Array<{ dirPath: string; children: unknown[] }>
    changes: Array<{
      type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
      path: string
      relativePath: string
      spaceId: string
      item?: unknown
    }>
  }) => void) => () => void
  openArtifact: (filePath: string) => Promise<IpcResponse>
  showArtifactInFolder: (filePath: string) => Promise<IpcResponse>
  readArtifactContent: (filePath: string) => Promise<IpcResponse>
  saveArtifactContent: (filePath: string, content: string) => Promise<IpcResponse>
  detectFileType: (filePath: string) => Promise<IpcResponse<{
    isText: boolean
    canViewInCanvas: boolean
    contentType: 'code' | 'markdown' | 'html' | 'image' | 'pdf' | 'text' | 'json' | 'csv' | 'binary'
    language?: string
    mimeType: string
  }>>

  // Onboarding
  writeOnboardingArtifact: (spaceId: string, filename: string, content: string) => Promise<IpcResponse>
  saveOnboardingConversation: (spaceId: string, userPrompt: string, aiResponse: string) => Promise<IpcResponse>

  // Remote Access
  enableRemoteAccess: (port?: number) => Promise<IpcResponse>
  disableRemoteAccess: () => Promise<IpcResponse>
  enableTunnel: () => Promise<IpcResponse>
  disableTunnel: () => Promise<IpcResponse>
  getRemoteStatus: () => Promise<IpcResponse>
  getRemoteQRCode: (includeToken?: boolean) => Promise<IpcResponse>
  setRemotePassword: (password: string) => Promise<IpcResponse>
  regenerateRemotePassword: () => Promise<IpcResponse>
  onRemoteStatusChange: (callback: (data: unknown) => void) => () => void

  // System Settings
  getAutoLaunch: () => Promise<IpcResponse>
  setAutoLaunch: (enabled: boolean) => Promise<IpcResponse>
  openLogFolder: () => Promise<IpcResponse>

  // Window
  setTitleBarOverlay: (options: { color: string; symbolColor: string }) => Promise<IpcResponse>
  maximizeWindow: () => Promise<IpcResponse>
  unmaximizeWindow: () => Promise<IpcResponse>
  isWindowMaximized: () => Promise<IpcResponse<boolean>>
  toggleMaximizeWindow: () => Promise<IpcResponse<boolean>>
  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void

  // Search
  search: (
    query: string,
    scope: 'conversation' | 'space' | 'global',
    conversationId?: string,
    spaceId?: string
  ) => Promise<IpcResponse>
  cancelSearch: () => Promise<IpcResponse>
  onSearchProgress: (callback: (data: unknown) => void) => () => void
  onSearchCancelled: (callback: () => void) => () => void

  // Updater
  checkForUpdates: () => Promise<IpcResponse>
  installUpdate: () => Promise<IpcResponse>
  getVersion: () => Promise<IpcResponse>
  onUpdaterStatus: (callback: (data: unknown) => void) => () => void

  // Browser (embedded browser for Content Canvas)
  getBrowserHomepage: () => Promise<IpcResponse>
  createBrowserView: (viewId: string, url?: string) => Promise<IpcResponse>
  destroyBrowserView: (viewId: string) => Promise<IpcResponse>
  showBrowserView: (viewId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<IpcResponse>
  hideBrowserView: (viewId: string) => Promise<IpcResponse>
  resizeBrowserView: (viewId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<IpcResponse>
  navigateBrowserView: (viewId: string, url: string) => Promise<IpcResponse>
  browserGoBack: (viewId: string) => Promise<IpcResponse>
  browserGoForward: (viewId: string) => Promise<IpcResponse>
  browserReload: (viewId: string) => Promise<IpcResponse>
  browserStop: (viewId: string) => Promise<IpcResponse>
  getBrowserState: (viewId: string) => Promise<IpcResponse>
  captureBrowserView: (viewId: string) => Promise<IpcResponse>
  executeBrowserJS: (viewId: string, code: string) => Promise<IpcResponse>
  setBrowserZoom: (viewId: string, level: number) => Promise<IpcResponse>
  toggleBrowserDevTools: (viewId: string) => Promise<IpcResponse>
  showBrowserContextMenu: (options: { viewId: string; url?: string; zoomLevel: number }) => Promise<IpcResponse>
  onBrowserStateChange: (callback: (data: unknown) => void) => () => void
  onBrowserZoomChanged: (callback: (data: { viewId: string; zoomLevel: number }) => void) => () => void

  // Canvas Tab Menu
  showCanvasTabContextMenu: (options: {
    tabId: string
    tabIndex: number
    tabTitle: string
    tabPath?: string
    tabCount: number
    hasTabsToRight: boolean
  }) => Promise<IpcResponse>
  onCanvasTabAction: (callback: (data: {
    action: 'close' | 'closeOthers' | 'closeToRight' | 'copyPath' | 'refresh'
    tabId?: string
    tabIndex?: number
    tabPath?: string
  }) => void) => () => void

  // AI Browser
  onAIBrowserActiveViewChanged: (callback: (data: { viewId: string; url: string | null; title: string | null }) => void) => () => void

  // Overlay (for floating UI above BrowserView)
  showChatCapsuleOverlay: () => Promise<IpcResponse>
  hideChatCapsuleOverlay: () => Promise<IpcResponse>
  onCanvasExitMaximized: (callback: () => void) => () => void

  // Performance Monitoring (Developer Tools)
  perfStart: (config?: { sampleInterval?: number; maxSamples?: number }) => Promise<IpcResponse>
  perfStop: () => Promise<IpcResponse>
  perfGetState: () => Promise<IpcResponse>
  perfGetHistory: () => Promise<IpcResponse>
  perfClearHistory: () => Promise<IpcResponse>
  perfSetConfig: (config: { enabled?: boolean; sampleInterval?: number; warnOnThreshold?: boolean }) => Promise<IpcResponse>
  perfExport: () => Promise<IpcResponse<string>>
  perfReportRendererMetrics: (metrics: {
    fps: number
    frameTime: number
    renderCount: number
    domNodes: number
    eventListeners: number
    jsHeapUsed: number
    jsHeapLimit: number
    longTasks: number
  }) => void
  onPerfSnapshot: (callback: (data: unknown) => void) => () => void
  onPerfWarning: (callback: (data: unknown) => void) => () => void

  // Git Bash (Windows only)
  getGitBashStatus: () => Promise<IpcResponse<{
    found: boolean
    path: string | null
    source: 'system' | 'app-local' | 'env-var' | null
  }>>
  installGitBash: (onProgress: (progress: {
    phase: 'downloading' | 'extracting' | 'configuring' | 'done' | 'error'
    progress: number
    message: string
    error?: string
  }) => void) => Promise<{ success: boolean; path?: string; error?: string }>
  openLoginWindow: (url: string, title?: string) => Promise<IpcResponse>
  openExternal: (url: string) => Promise<void>

  // Bootstrap lifecycle
  getBootstrapStatus: () => Promise<IpcResponse<{
    extendedReady: boolean
    extendedReadyAt: number
  }>>
  onBootstrapExtendedReady: (callback: (data: { timestamp: number; duration: number }) => void) => () => void

  // Health System
  getHealthStatus: () => Promise<IpcResponse<HealthStatusResponse>>
  getHealthState: () => Promise<IpcResponse<HealthStateResponse>>
  triggerHealthRecovery: (strategyId: string, userConsented: boolean) => Promise<IpcResponse<HealthRecoveryResponse>>
  generateHealthReport: () => Promise<IpcResponse<HealthReportResponse>>
  generateHealthReportText: () => Promise<IpcResponse<string>>
  exportHealthReport: (filePath?: string) => Promise<IpcResponse<HealthExportResponse>>
  runHealthCheck: () => Promise<IpcResponse<HealthCheckResponse>>

  // Notification Channels
  testNotificationChannel: (channelType: string) => Promise<IpcResponse>
  clearNotificationChannelCache: () => Promise<IpcResponse>

  // Apps Management
  appList: (filter?: { spaceId?: string; status?: string; type?: string }) => Promise<IpcResponse>
  appGet: (appId: string) => Promise<IpcResponse>
  appInstall: (input: { spaceId: string | null; spec: unknown; userConfig?: Record<string, unknown> }) => Promise<IpcResponse>
  appUninstall: (input: { appId: string; options?: { purge?: boolean } }) => Promise<IpcResponse>
  appReinstall: (input: { appId: string }) => Promise<IpcResponse>
  appDelete: (input: { appId: string }) => Promise<IpcResponse>
  appPause: (appId: string) => Promise<IpcResponse>
  appResume: (appId: string) => Promise<IpcResponse>
  appTrigger: (appId: string) => Promise<IpcResponse>
  appGetState: (appId: string) => Promise<IpcResponse>
  appGetActivity: (input: { appId: string; options?: { limit?: number; offset?: number; type?: string; since?: number } }) => Promise<IpcResponse>
  appGetSession: (input: { appId: string; runId: string }) => Promise<IpcResponse>
  appRespondEscalation: (input: { appId: string; escalationId: string; response: { ts: number; choice?: string; text?: string } }) => Promise<IpcResponse>
  appUpdateConfig: (input: { appId: string; config: Record<string, unknown> }) => Promise<IpcResponse>
  appUpdateFrequency: (input: { appId: string; subscriptionId: string; frequency: string }) => Promise<IpcResponse>
  appUpdateOverrides: (input: { appId: string; overrides: Record<string, unknown> }) => Promise<IpcResponse>
  appUpdateSpec: (input: { appId: string; specPatch: Record<string, unknown> }) => Promise<IpcResponse>
  appGrantPermission: (input: { appId: string; permission: string }) => Promise<IpcResponse>
  appRevokePermission: (input: { appId: string; permission: string }) => Promise<IpcResponse>

  // App Import / Export
  appExportSpec: (appId: string) => Promise<IpcResponse<{ yaml: string; filename: string }>>
  appImportSpec: (input: { spaceId: string; yamlContent: string; userConfig?: Record<string, unknown> }) => Promise<IpcResponse>
  appOpenSkillFolder: (appId: string) => Promise<IpcResponse>
  appGetDataPath: (appId: string) => Promise<IpcResponse<{ path: string }>>
  appOpenDataFolder: (appId: string) => Promise<IpcResponse>
  appMoveSpace: (input: { appId: string; newSpaceId: string | null }) => Promise<IpcResponse>

  // App Chat
  appChatSend: (request: { appId: string; spaceId: string; message: string; images?: Array<{ type: string; media_type: string; data: string }>; thinkingEnabled?: boolean }) => Promise<IpcResponse>
  appChatStop: (appId: string) => Promise<IpcResponse>
  appChatStatus: (appId: string) => Promise<IpcResponse>
  appChatMessages: (input: { appId: string; spaceId: string }) => Promise<IpcResponse>
  appChatSessionState: (appId: string) => Promise<IpcResponse>
  appChatClear: (input: { appId: string; spaceId: string }) => Promise<IpcResponse>

  // App Event Listeners
  onAppStatusChanged: (callback: (data: unknown) => void) => () => void
  onAppActivityEntry: (callback: (data: unknown) => void) => () => void
  onAppEscalation: (callback: (data: unknown) => void) => () => void
  onAppNavigate: (callback: (data: unknown) => void) => () => void

  // Notification (in-app toast)
  onNotificationToast: (callback: (data: unknown) => void) => () => void

  // Store (App Registry)
  storeQuery: (params: { search?: string; type?: string; category?: string; page?: number; pageSize?: number; locale?: string }) => Promise<IpcResponse>
  storeListApps: (query: { search?: string; locale?: string; category?: string; type?: string; tags?: string[] }) => Promise<IpcResponse>
  storeGetAppDetail: (slug: string) => Promise<IpcResponse>
  storeInstall: (
    input: { slug: string; spaceId: string | null; userConfig?: Record<string, unknown> },
    onProgress?: (progress: StoreInstallProgress) => void,
  ) => Promise<IpcResponse>
  storeRefresh: () => Promise<IpcResponse>
  storeCheckUpdates: () => Promise<IpcResponse>
  storeGetRegistries: () => Promise<IpcResponse>
  storeAddRegistry: (input: { name: string; url: string; sourceType?: string; adapterConfig?: Record<string, unknown> }) => Promise<IpcResponse>
  storeRemoveRegistry: (registryId: string) => Promise<IpcResponse>
  storeToggleRegistry: (input: { registryId: string; enabled: boolean }) => Promise<IpcResponse>
  storeUpdateRegistryAdapterConfig: (input: { registryId: string; adapterConfig: Record<string, unknown> }) => Promise<IpcResponse>
  onStoreSyncStatusChanged: (callback: (data: { registryId: string; status: string; appCount: number; error?: string }) => void) => () => void
}

interface IpcResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// Create event listener with cleanup
function createEventListener(channel: string, callback: (data: unknown) => void): () => void {
  console.log(`[Preload] Creating event listener for channel: ${channel}`)

  const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
    console.log(`[Preload] Received event on channel: ${channel}`, data)
    callback(data)
  }

  ipcRenderer.on(channel, handler)

  return () => {
    console.log(`[Preload] Removing event listener for channel: ${channel}`)
    ipcRenderer.removeListener(channel, handler)
  }
}

// Expose API to renderer
const api: HaloAPI = {
  // Generic Auth (provider-agnostic)
  authGetProviders: () => ipcRenderer.invoke('auth:get-providers'),
  authGetBuiltinProviders: () => ipcRenderer.invoke('auth:get-builtin-providers'),
  authStartLogin: (providerType) => ipcRenderer.invoke('auth:start-login', providerType),
  authCompleteLogin: (providerType, state) => ipcRenderer.invoke('auth:complete-login', providerType, state),
  authRefreshToken: (sourceId) => ipcRenderer.invoke('auth:refresh-token', sourceId),
  authCheckToken: (sourceId) => ipcRenderer.invoke('auth:check-token', sourceId),
  authLogout: (sourceId) => ipcRenderer.invoke('auth:logout', sourceId),
  onAuthLoginProgress: (callback) => createEventListener('auth:login-progress', callback as (data: unknown) => void),

  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (updates) => ipcRenderer.invoke('config:set', updates),
  validateApi: (apiKey, apiUrl, provider, model?) =>
    ipcRenderer.invoke('config:validate-api', apiKey, apiUrl, provider, model),
  fetchModels: (apiKey, apiUrl) =>
    ipcRenderer.invoke('config:fetch-models', apiKey, apiUrl),
  refreshAISourcesConfig: () => ipcRenderer.invoke('config:refresh-ai-sources'),

  // AI Sources CRUD (atomic - backend reads from disk, never overwrites rotating tokens)
  aiSourcesSwitchSource: (sourceId) => ipcRenderer.invoke('ai-sources:switch-source', sourceId),
  aiSourcesSetModel: (modelId) => ipcRenderer.invoke('ai-sources:set-model', modelId),
  aiSourcesAddSource: (source) => ipcRenderer.invoke('ai-sources:add-source', source),
  aiSourcesUpdateSource: (sourceId, updates) => ipcRenderer.invoke('ai-sources:update-source', sourceId, updates),
  aiSourcesDeleteSource: (sourceId) => ipcRenderer.invoke('ai-sources:delete-source', sourceId),

  // Space
  getHaloSpace: () => ipcRenderer.invoke('space:get-halo'),
  listSpaces: () => ipcRenderer.invoke('space:list'),
  createSpace: (input) => ipcRenderer.invoke('space:create', input),
  deleteSpace: (spaceId) => ipcRenderer.invoke('space:delete', spaceId),
  getSpace: (spaceId) => ipcRenderer.invoke('space:get', spaceId),
  openSpaceFolder: (spaceId) => ipcRenderer.invoke('space:open-folder', spaceId),
  updateSpace: (spaceId, updates) => ipcRenderer.invoke('space:update', spaceId, updates),
  getDefaultSpacePath: () => ipcRenderer.invoke('space:get-default-path'),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  updateSpacePreferences: (spaceId, preferences) =>
    ipcRenderer.invoke('space:update-preferences', spaceId, preferences),
  getSpacePreferences: (spaceId) => ipcRenderer.invoke('space:get-preferences', spaceId),

  // Conversation
  listConversations: (spaceId) => ipcRenderer.invoke('conversation:list', spaceId),
  createConversation: (spaceId, title) => ipcRenderer.invoke('conversation:create', spaceId, title),
  getConversation: (spaceId, conversationId) =>
    ipcRenderer.invoke('conversation:get', spaceId, conversationId),
  updateConversation: (spaceId, conversationId, updates) =>
    ipcRenderer.invoke('conversation:update', spaceId, conversationId, updates),
  deleteConversation: (spaceId, conversationId) =>
    ipcRenderer.invoke('conversation:delete', spaceId, conversationId),
  addMessage: (spaceId, conversationId, message) =>
    ipcRenderer.invoke('conversation:add-message', spaceId, conversationId, message),
  updateLastMessage: (spaceId, conversationId, updates) =>
    ipcRenderer.invoke('conversation:update-last-message', spaceId, conversationId, updates),
  getMessageThoughts: (spaceId, conversationId, messageId) =>
    ipcRenderer.invoke('conversation:get-thoughts', spaceId, conversationId, messageId),
  toggleStarConversation: (spaceId, conversationId, starred) =>
    ipcRenderer.invoke('conversation:toggle-star', spaceId, conversationId, starred),

  // Agent
  sendMessage: (request) => ipcRenderer.invoke('agent:send-message', request),
  stopGeneration: (conversationId) => ipcRenderer.invoke('agent:stop', conversationId),
  approveTool: (conversationId) => ipcRenderer.invoke('agent:approve-tool', conversationId),
  rejectTool: (conversationId) => ipcRenderer.invoke('agent:reject-tool', conversationId),
  getSessionState: (conversationId) => ipcRenderer.invoke('agent:get-session-state', conversationId),
  ensureSessionWarm: (spaceId, conversationId) => ipcRenderer.invoke('agent:ensure-session-warm', spaceId, conversationId),
  testMcpConnections: () => ipcRenderer.invoke('agent:test-mcp'),
  answerQuestion: (data) => ipcRenderer.invoke('agent:answer-question', data),

  // Event listeners
  onAgentMessage: (callback) => createEventListener('agent:message', callback),
  onAgentToolCall: (callback) => createEventListener('agent:tool-call', callback),
  onAgentToolResult: (callback) => createEventListener('agent:tool-result', callback),
  onAgentError: (callback) => createEventListener('agent:error', callback),
  onAgentComplete: (callback) => createEventListener('agent:complete', callback),
  onAgentThinking: (callback) => createEventListener('agent:thinking', callback),
  onAgentThought: (callback) => createEventListener('agent:thought', callback),
  onAgentThoughtDelta: (callback) => createEventListener('agent:thought-delta', callback),
  onAgentMcpStatus: (callback) => createEventListener('agent:mcp-status', callback),
  onAgentCompact: (callback) => createEventListener('agent:compact', callback),
  onAgentAskQuestion: (callback) => createEventListener('agent:ask-question', callback),
  onAgentSessionInfo: (callback) => createEventListener('agent:session-info', callback),

  // Artifact
  listArtifacts: (spaceId, maxDepth = 2) => ipcRenderer.invoke('artifact:list', spaceId, maxDepth),
  listArtifactsTree: (spaceId) => ipcRenderer.invoke('artifact:list-tree', spaceId),
  loadArtifactChildren: (spaceId, dirPath) => ipcRenderer.invoke('artifact:load-children', spaceId, dirPath),
  initArtifactWatcher: (spaceId) => ipcRenderer.invoke('artifact:init-watcher', spaceId),
  onArtifactChanged: (callback) => createEventListener('artifact:changed', callback as (data: unknown) => void),
  onArtifactTreeUpdate: (callback) => createEventListener('artifact:tree-update', callback as (data: unknown) => void),
  openArtifact: (filePath) => ipcRenderer.invoke('artifact:open', filePath),
  showArtifactInFolder: (filePath) => ipcRenderer.invoke('artifact:show-in-folder', filePath),
  readArtifactContent: (filePath) => ipcRenderer.invoke('artifact:read-content', filePath),
  saveArtifactContent: (filePath, content) => ipcRenderer.invoke('artifact:save-content', filePath, content),
  detectFileType: (filePath) => ipcRenderer.invoke('artifact:detect-file-type', filePath),

  // Onboarding
  writeOnboardingArtifact: (spaceId, filename, content) =>
    ipcRenderer.invoke('onboarding:write-artifact', spaceId, filename, content),
  saveOnboardingConversation: (spaceId, userPrompt, aiResponse) =>
    ipcRenderer.invoke('onboarding:save-conversation', spaceId, userPrompt, aiResponse),

  // Remote Access
  enableRemoteAccess: (port) => ipcRenderer.invoke('remote:enable', port),
  disableRemoteAccess: () => ipcRenderer.invoke('remote:disable'),
  enableTunnel: () => ipcRenderer.invoke('remote:tunnel:enable'),
  disableTunnel: () => ipcRenderer.invoke('remote:tunnel:disable'),
  getRemoteStatus: () => ipcRenderer.invoke('remote:status'),
  getRemoteQRCode: (includeToken) => ipcRenderer.invoke('remote:qrcode', includeToken),
  setRemotePassword: (password) => ipcRenderer.invoke('remote:set-password', password),
  regenerateRemotePassword: () => ipcRenderer.invoke('remote:regenerate-password'),
  onRemoteStatusChange: (callback) => createEventListener('remote:status-change', callback),

  // System Settings
  getAutoLaunch: () => ipcRenderer.invoke('system:get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('system:set-auto-launch', enabled),
  openLogFolder: () => ipcRenderer.invoke('system:open-log-folder'),

  // Window
  setTitleBarOverlay: (options) => ipcRenderer.invoke('window:set-title-bar-overlay', options),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  unmaximizeWindow: () => ipcRenderer.invoke('window:unmaximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  onWindowMaximizeChange: (callback) => createEventListener('window:maximize-change', callback as (data: unknown) => void),

  // Search
  search: (query, scope, conversationId, spaceId) =>
    ipcRenderer.invoke('search:execute', query, scope, conversationId, spaceId),
  cancelSearch: () => ipcRenderer.invoke('search:cancel'),
  onSearchProgress: (callback) => createEventListener('search:progress', callback),
  onSearchCancelled: (callback) => createEventListener('search:cancelled', callback),

  // Updater
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getVersion: () => ipcRenderer.invoke('updater:get-version'),
  onUpdaterStatus: (callback) => createEventListener('updater:status', callback),

  // Browser (embedded browser for Content Canvas)
  getBrowserHomepage: () => ipcRenderer.invoke('browser:get-homepage'),
  createBrowserView: (viewId, url) => ipcRenderer.invoke('browser:create', { viewId, url }),
  destroyBrowserView: (viewId) => ipcRenderer.invoke('browser:destroy', { viewId }),
  showBrowserView: (viewId, bounds) => ipcRenderer.invoke('browser:show', { viewId, bounds }),
  hideBrowserView: (viewId) => ipcRenderer.invoke('browser:hide', { viewId }),
  resizeBrowserView: (viewId, bounds) => ipcRenderer.invoke('browser:resize', { viewId, bounds }),
  navigateBrowserView: (viewId, url) => ipcRenderer.invoke('browser:navigate', { viewId, url }),
  browserGoBack: (viewId) => ipcRenderer.invoke('browser:go-back', { viewId }),
  browserGoForward: (viewId) => ipcRenderer.invoke('browser:go-forward', { viewId }),
  browserReload: (viewId) => ipcRenderer.invoke('browser:reload', { viewId }),
  browserStop: (viewId) => ipcRenderer.invoke('browser:stop', { viewId }),
  getBrowserState: (viewId) => ipcRenderer.invoke('browser:get-state', { viewId }),
  captureBrowserView: (viewId) => ipcRenderer.invoke('browser:capture', { viewId }),
  executeBrowserJS: (viewId, code) => ipcRenderer.invoke('browser:execute-js', { viewId, code }),
  setBrowserZoom: (viewId, level) => ipcRenderer.invoke('browser:zoom', { viewId, level }),
  toggleBrowserDevTools: (viewId) => ipcRenderer.invoke('browser:dev-tools', { viewId }),
  showBrowserContextMenu: (options) => ipcRenderer.invoke('browser:show-context-menu', options),
  onBrowserStateChange: (callback) => createEventListener('browser:state-change', callback),
  onBrowserZoomChanged: (callback) => createEventListener('browser:zoom-changed', callback as (data: unknown) => void),

  // Canvas Tab Menu (native Electron menu)
  showCanvasTabContextMenu: (options) => ipcRenderer.invoke('canvas:show-tab-context-menu', options),
  onCanvasTabAction: (callback) => createEventListener('canvas:tab-action', callback as (data: unknown) => void),

  // AI Browser - active view change notification from main process
  onAIBrowserActiveViewChanged: (callback) => createEventListener('ai-browser:active-view-changed', callback as (data: unknown) => void),

  // Overlay (for floating UI above BrowserView)
  showChatCapsuleOverlay: () => ipcRenderer.invoke('overlay:show-chat-capsule'),
  hideChatCapsuleOverlay: () => ipcRenderer.invoke('overlay:hide-chat-capsule'),
  onCanvasExitMaximized: (callback) => createEventListener('canvas:exit-maximized', callback as (data: unknown) => void),

  // Performance Monitoring (Developer Tools)
  perfStart: (config) => ipcRenderer.invoke('perf:start', config),
  perfStop: () => ipcRenderer.invoke('perf:stop'),
  perfGetState: () => ipcRenderer.invoke('perf:get-state'),
  perfGetHistory: () => ipcRenderer.invoke('perf:get-history'),
  perfClearHistory: () => ipcRenderer.invoke('perf:clear-history'),
  perfSetConfig: (config) => ipcRenderer.invoke('perf:set-config', config),
  perfExport: () => ipcRenderer.invoke('perf:export'),
  perfReportRendererMetrics: (metrics) => ipcRenderer.send('perf:renderer-metrics', metrics),
  onPerfSnapshot: (callback) => createEventListener('perf:snapshot', callback),
  onPerfWarning: (callback) => createEventListener('perf:warning', callback),

  // Git Bash (Windows only)
  getGitBashStatus: () => ipcRenderer.invoke('git-bash:status'),
  installGitBash: async (onProgress) => {
    // Create a unique channel for this installation
    const progressChannel = `git-bash:install-progress-${Date.now()}`

    // Set up progress listener
    const progressHandler = (_event: Electron.IpcRendererEvent, progress: unknown) => {
      onProgress(progress as Parameters<typeof onProgress>[0])
    }
    ipcRenderer.on(progressChannel, progressHandler)

    try {
      const result = await ipcRenderer.invoke('git-bash:install', { progressChannel })
      return result as { success: boolean; path?: string; error?: string }
    } finally {
      ipcRenderer.removeListener(progressChannel, progressHandler)
    }
  },
  openLoginWindow: (url, title) => ipcRenderer.invoke('browser:open-login-window', { url, title }),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // Bootstrap lifecycle
  getBootstrapStatus: () => ipcRenderer.invoke('bootstrap:get-status'),
  onBootstrapExtendedReady: (callback) => createEventListener('bootstrap:extended-ready', callback as (data: unknown) => void),

  // Health System
  getHealthStatus: () => ipcRenderer.invoke('health:get-status'),
  getHealthState: () => ipcRenderer.invoke('health:get-state'),
  triggerHealthRecovery: (strategyId, userConsented) => ipcRenderer.invoke('health:trigger-recovery', strategyId, userConsented),
  generateHealthReport: () => ipcRenderer.invoke('health:generate-report'),
  generateHealthReportText: () => ipcRenderer.invoke('health:generate-report-text'),
  exportHealthReport: (filePath) => ipcRenderer.invoke('health:export-report', filePath),
  runHealthCheck: () => ipcRenderer.invoke('health:run-check'),

  // Notification Channels
  testNotificationChannel: (channelType: string) => ipcRenderer.invoke('notify-channels:test', channelType),
  clearNotificationChannelCache: () => ipcRenderer.invoke('notify-channels:clear-cache'),

  // Apps Management
  appList: (filter) => ipcRenderer.invoke('app:list', filter),
  appGet: (appId) => ipcRenderer.invoke('app:get', appId),
  appInstall: (input) => ipcRenderer.invoke('app:install', input),
  appUninstall: (input) => ipcRenderer.invoke('app:uninstall', input),
  appReinstall: (input) => ipcRenderer.invoke('app:reinstall', input),
  appDelete: (input) => ipcRenderer.invoke('app:delete', input),
  appPause: (appId) => ipcRenderer.invoke('app:pause', appId),
  appResume: (appId) => ipcRenderer.invoke('app:resume', appId),
  appTrigger: (appId) => ipcRenderer.invoke('app:trigger', appId),
  appGetState: (appId) => ipcRenderer.invoke('app:get-state', appId),
  appGetActivity: (input) => ipcRenderer.invoke('app:get-activity', input),
  appGetSession: (input) => ipcRenderer.invoke('app:get-session', input),
  appRespondEscalation: (input) => ipcRenderer.invoke('app:respond-escalation', input),
  appUpdateConfig: (input) => ipcRenderer.invoke('app:update-config', input),
  appUpdateFrequency: (input) => ipcRenderer.invoke('app:update-frequency', input),
  appUpdateOverrides: (input) => ipcRenderer.invoke('app:update-overrides', input),
  appUpdateSpec: (input) => ipcRenderer.invoke('app:update-spec', input),
  appGrantPermission: (input) => ipcRenderer.invoke('app:grant-permission', input),
  appRevokePermission: (input) => ipcRenderer.invoke('app:revoke-permission', input),

  // App Import / Export
  appExportSpec: (appId) => ipcRenderer.invoke('app:export-spec', appId),
  appImportSpec: (input) => ipcRenderer.invoke('app:import-spec', input),
  appOpenSkillFolder: (appId) => ipcRenderer.invoke('app:open-skill-folder', appId),
  appGetDataPath: (appId) => ipcRenderer.invoke('app:get-data-path', appId),
  appOpenDataFolder: (appId) => ipcRenderer.invoke('app:open-data-folder', appId),
  appMoveSpace: (input) => ipcRenderer.invoke('app:move-space', input),

  // App Chat
  appChatSend: (request) => ipcRenderer.invoke('app:chat-send', request),
  appChatStop: (appId) => ipcRenderer.invoke('app:chat-stop', appId),
  appChatStatus: (appId) => ipcRenderer.invoke('app:chat-status', appId),
  appChatMessages: (input) => ipcRenderer.invoke('app:chat-messages', input),
  appChatSessionState: (appId) => ipcRenderer.invoke('app:chat-session-state', appId),
  appChatClear: (input) => ipcRenderer.invoke('app:chat-clear', input),

  // App Event Listeners
  onAppStatusChanged: (callback) => createEventListener('app:status_changed', callback),
  onAppActivityEntry: (callback) => createEventListener('app:activity_entry:new', callback),
  onAppEscalation: (callback) => createEventListener('app:escalation:new', callback),
  onAppNavigate: (callback) => createEventListener('app:navigate', callback),

  // Store (App Registry)
  storeQuery: (params) => ipcRenderer.invoke('store:query', params),
  storeListApps: (query) => ipcRenderer.invoke('store:list-apps', query),
  storeGetAppDetail: (slug) => ipcRenderer.invoke('store:get-app-detail', slug),
  storeInstall: async (input, onProgress) => {
    if (!onProgress) {
      return ipcRenderer.invoke('store:install', input)
    }
    // Create a unique per-install channel for progress events (mirrors installGitBash pattern)
    const progressChannel = `store:install-progress-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const progressHandler = (_event: Electron.IpcRendererEvent, progress: StoreInstallProgress) => {
      onProgress(progress)
    }
    ipcRenderer.on(progressChannel, progressHandler)
    try {
      return await ipcRenderer.invoke('store:install', { ...input, progressChannel })
    } finally {
      ipcRenderer.removeListener(progressChannel, progressHandler)
    }
  },
  storeRefresh: () => ipcRenderer.invoke('store:refresh'),
  storeCheckUpdates: () => ipcRenderer.invoke('store:check-updates'),
  storeGetRegistries: () => ipcRenderer.invoke('store:get-registries'),
  storeAddRegistry: (input) => ipcRenderer.invoke('store:add-registry', input),
  storeRemoveRegistry: (registryId) => ipcRenderer.invoke('store:remove-registry', registryId),
  storeToggleRegistry: (input) => ipcRenderer.invoke('store:toggle-registry', input),
  storeUpdateRegistryAdapterConfig: (input) => ipcRenderer.invoke('store:update-registry-adapter-config', input),
  onStoreSyncStatusChanged: (callback) => createEventListener('store:sync-status-changed', callback as (data: unknown) => void),

  // Notification (in-app toast)
  onNotificationToast: (callback) => createEventListener('notification:toast', callback),
}

contextBridge.exposeInMainWorld('halo', api)

// Analytics: Listen for tracking events from main process
// Baidu Tongji SDK is loaded in index.html, we just need to call _hmt.push()
// Note: _hmt is initialized as an array in index.html before SDK loads
// The SDK will process queued commands when it loads
ipcRenderer.on('analytics:track', (_event, data: {
  type: string
  category: string
  action: string
  label?: string
  value?: number
  customVars?: Record<string, unknown>
}) => {
  try {
    // _hmt is defined in index.html as: var _hmt = _hmt || []
    // We can push commands to it before SDK fully loads - SDK will process them
    const win = window as unknown as { _hmt?: unknown[][] }

    // Ensure _hmt exists
    if (!win._hmt) {
      win._hmt = []
    }

    if (data.type === 'trackEvent') {
      // _hmt.push(['_trackEvent', category, action, opt_label, opt_value])
      win._hmt.push(['_trackEvent', data.category, data.action, data.label || '', data.value || 0])
      console.log('[Analytics] Baidu event queued:', data.action)
    }
  } catch (error) {
    console.warn('[Analytics] Failed to track Baidu event:', error)
  }
})

// Expose platform info for cross-platform UI adjustments
const platformInfo = {
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  isLinux: process.platform === 'linux'
}

contextBridge.exposeInMainWorld('platform', platformInfo)

// Expose basic electron IPC for overlay SPA
// This is used by the overlay window which doesn't need the full halo API
const electronAPI = {
  ipcRenderer: {
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args))
    },
    removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
      ipcRenderer.removeListener(channel, callback as (...args: unknown[]) => void)
    },
    send: (channel: string, ...args: unknown[]) => {
      ipcRenderer.send(channel, ...args)
    }
  }
}

contextBridge.exposeInMainWorld('electron', electronAPI)

// TypeScript declaration for window.halo and window.platform
declare global {
  interface Window {
    halo: HaloAPI
    platform: {
      platform: 'darwin' | 'win32' | 'linux'
      isMac: boolean
      isWindows: boolean
      isLinux: boolean
    }
    // For overlay SPA - access via contextBridge
    electron?: {
      ipcRenderer: {
        on: (channel: string, callback: (...args: unknown[]) => void) => void
        removeListener: (channel: string, callback: (...args: unknown[]) => void) => void
        send: (channel: string, ...args: unknown[]) => void
      }
    }
  }
}
