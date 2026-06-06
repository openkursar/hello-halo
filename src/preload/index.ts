/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Preload Script - Exposes IPC to renderer
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { RpcContract, RpcClient } from '../shared/rpc/define'
import { modelCapabilitiesRpc } from '../shared/rpc/contracts/model-capabilities.contract'
import { onboardingRpc } from '../shared/rpc/contracts/onboarding.contract'
import { securityRpc } from '../shared/rpc/contracts/security.contract'
import { perfRpc } from '../shared/rpc/contracts/perf.contract'
import { notificationChannelsRpc } from '../shared/rpc/contracts/notification-channels.contract'
import { imSessionsRpc } from '../shared/rpc/contracts/im-sessions.contract'
import { cliConfigRpc } from '../shared/rpc/contracts/cli-config.contract'
import { imChannelsRpc } from '../shared/rpc/contracts/im-channels.contract'
import { weixinIlinkRpc } from '../shared/rpc/contracts/weixin-ilink.contract'
import { conversationRpc } from '../shared/rpc/contracts/conversation.contract'
import { spaceRpc } from '../shared/rpc/contracts/space.contract'
import { storeRpc } from '../shared/rpc/contracts/store.contract'
import { remoteRpc } from '../shared/rpc/contracts/remote.contract'
import { authRpc } from '../shared/rpc/contracts/auth.contract'
import { systemRpc } from '../shared/rpc/contracts/system.contract'
import { healthRpc } from '../shared/rpc/contracts/health.contract'
import { configRpc } from '../shared/rpc/contracts/config.contract'
import { agentRpc } from '../shared/rpc/contracts/agent.contract'
import { artifactRpc } from '../shared/rpc/contracts/artifact.contract'
import { searchRpc } from '../shared/rpc/contracts/search.contract'
import { wecomBotRpc } from '../shared/rpc/contracts/wecom-bot.contract'
import { gitBashRpc } from '../shared/rpc/contracts/git-bash.contract'
import { overlayRpc } from '../shared/rpc/contracts/overlay.contract'
import { appRpc } from '../shared/rpc/contracts/app.contract'
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
  authOpenLoginWindow: (providerType: string, loginUrl: string, redirectUri: string) => Promise<IpcResponse>
  authCompleteLogin: (providerType: string, state: string) => Promise<IpcResponse>
  authRefreshToken: (sourceId: string) => Promise<IpcResponse>
  authCheckToken: (sourceId: string) => Promise<IpcResponse>
  authLogout: (sourceId: string) => Promise<IpcResponse>
  onAuthLoginProgress: (callback: (data: { provider: string; status: string }) => void) => () => void

  // Config
  getConfig: () => Promise<IpcResponse>
  setConfig: (updates: Record<string, unknown>) => Promise<IpcResponse>
  validateApi: (apiKey: string, apiUrl: string, provider: string, model?: string) => Promise<IpcResponse>
  fetchModels: (apiKey: string, apiUrl: string) => Promise<IpcResponse>
  refreshAISourcesConfig: () => Promise<IpcResponse>

  // CLI Config (Skills + MCP migration, config dir mode)
  cliConfigGetPaths: () => Promise<IpcResponse>
  cliConfigScanSkills: () => Promise<IpcResponse>
  cliConfigMigrateSkills: (actions: Array<{ name: string; action: 'skip' | 'overwrite' | 'rename' }>) => Promise<IpcResponse>
  cliConfigScanMcp: () => Promise<IpcResponse>
  cliConfigMigrateMcp: (actions: Array<{ name: string; action: 'skip' | 'overwrite' }>) => Promise<IpcResponse>
  cliConfigSetConfigDir: (mode: 'halo' | 'cc' | 'custom', customDir?: string) => Promise<IpcResponse>

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
  injectMessage: (data: { conversationId: string; message: string }) => Promise<IpcResponse>
  getEngineCapabilities: () => Promise<IpcResponse>

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
  onAgentTurnStart: (callback: (data: unknown) => void) => () => void

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
  reconcileArtifacts: (spaceId: string) => Promise<IpcResponse>
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

  // File operations — create/move send (parentPath, name), backend constructs full path
  createArtifactFile: (spaceId: string, parentPath: string, name: string, content?: string) => Promise<IpcResponse>
  createArtifactFolder: (spaceId: string, parentPath: string, name: string) => Promise<IpcResponse>
  deleteArtifact: (spaceId: string, targetPath: string) => Promise<IpcResponse>
  renameArtifact: (spaceId: string, oldPath: string, newName: string) => Promise<IpcResponse>
  moveArtifact: (spaceId: string, oldPath: string, newParentPath: string) => Promise<IpcResponse>

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

  // Security policy (renderer-safe slice — see ipc/security.ts)
  getSecurityPolicy: () => Promise<IpcResponse>

  // System Settings
  getAutoLaunch: () => Promise<IpcResponse>
  setAutoLaunch: (enabled: boolean) => Promise<IpcResponse>
  openLogFolder: () => Promise<IpcResponse>
  relaunch: () => Promise<IpcResponse>

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
  setBrowserDeviceMode: (viewId: string, mode: 'pc' | 'h5') => Promise<IpcResponse>
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
    source: 'system' | 'app-local' | 'env-var' | 'mock' | null
    mockMode?: boolean
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

  // WeCom Bot (企业微信智能机器人) — legacy compat
  getWecomBotStatus: () => Promise<IpcResponse>
  reconnectWecomBot: () => Promise<IpcResponse>

  // WeCom Bot — Scan-Auth (QR-code device flow)
  wecomBotScanAuthStart: () => Promise<IpcResponse<{ scode: string; authUrl: string }>>
  wecomBotScanAuthPoll: (scode: string) => Promise<IpcResponse<{ botId: string; secret: string }> & { kind?: string }>
  wecomBotScanAuthCancel: (scode: string) => Promise<IpcResponse>
  wecomBotScanAuthCreateAssistant: (input: { botIdPrefix: string }) => Promise<IpcResponse<{ appId: string; appName: string }>>

  // IM Channels (multi-instance)
  imChannelsStatus: () => Promise<IpcResponse>
  imChannelsInstanceStatus: (instanceId: string) => Promise<IpcResponse>
  imChannelsReconnect: (instanceId: string) => Promise<IpcResponse>
  imChannelsReload: () => Promise<IpcResponse>
  imChannelsProviders: () => Promise<IpcResponse>
  imChannelsPermissionDefaults: () => Promise<IpcResponse>

  // IM Sessions
  imSessionsList: (appId?: string) => Promise<IpcResponse>
  imSessionsSetProactive: (input: { appId: string; channel: string; chatId: string; proactive: boolean }) => Promise<IpcResponse>
  imSessionsRemove: (input: { appId: string; channel: string; chatId: string }) => Promise<IpcResponse>
  imSessionsSetCustomName: (input: { appId: string; channel: string; chatId: string; name: string }) => Promise<IpcResponse>

  // WeChat Personal Bot via iLink API
  weixinIlinkRequestQrcode: () => Promise<IpcResponse<{ qrcode: string; qrcodeImgContent: string; baseUrl: string }>>
  weixinIlinkPollAuthStatus: (qrcode: string) => Promise<IpcResponse<{ status: 'wait' | 'scaned' | 'confirmed' | 'expired'; botToken?: string; accountId?: string; baseUrl?: string; userId?: string }>>
  weixinIlinkSaveToken: (instanceId: string, botToken: string, baseUrl?: string, accountId?: string) => Promise<IpcResponse>
  weixinIlinkDisconnect: (instanceId: string) => Promise<IpcResponse>

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
  appContinueRun: (input: { appId: string; runId: string }) => Promise<IpcResponse>
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
  appClearMemory: (appId: string) => Promise<IpcResponse<{ filesRemoved: number }>>
  appMoveSpace: (input: { appId: string; newSpaceId: string | null }) => Promise<IpcResponse>

  // App Chat
  appChatSend: (request: { appId: string; spaceId: string; message: string; images?: Array<{ type: string; media_type: string; data: string }>; thinkingEnabled?: boolean }) => Promise<IpcResponse>
  appChatStop: (appId: string) => Promise<IpcResponse>
  appChatStatus: (appId: string) => Promise<IpcResponse>
  appChatMessages: (input: { appId: string; spaceId: string }) => Promise<IpcResponse>
  appChatSessionState: (appId: string) => Promise<IpcResponse>
  appChatClear: (input: { appId: string; spaceId: string }) => Promise<IpcResponse>
  appChatRestart: (appId: string) => Promise<IpcResponse<{ sessionsClosed: number }>>
  appImChatMessages: (input: { appId: string; spaceId: string; channel: string; chatType: 'direct' | 'group'; chatId: string }) => Promise<IpcResponse>
  appImChatClear: (input: { appId: string; spaceId: string; channel: string; chatType: 'direct' | 'group'; chatId: string }) => Promise<IpcResponse>

  // App Event Listeners
  onAppStatusChanged: (callback: (data: unknown) => void) => () => void
  onAppActivityEntry: (callback: (data: unknown) => void) => () => void
  onAppEscalation: (callback: (data: unknown) => void) => () => void
  onAppNavigate: (callback: (data: unknown) => void) => () => void
  onImSessionUpdated: (callback: (data: unknown) => void) => () => void
  onImChannelInstanceUpdated: (callback: (data: unknown) => void) => () => void

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

  // Model Capabilities
  /** Resolve the final capability for a model (preset merged with user overrides) */
  modelCapabilitiesResolve: (modelId: string, overrides?: Record<string, Record<string, unknown>>) => Promise<IpcResponse>
  /** Get the raw preset for a model (no overrides applied), or null if not in preset */
  modelCapabilitiesGetPreset: (modelId: string) => Promise<IpcResponse>
  /** Get all preset model capabilities as a flat map */
  modelCapabilitiesAll: () => Promise<IpcResponse>

  // Telemetry (fire-and-forget — no response)
  trackEvent: (event: string, properties?: Record<string, unknown>) => void
}

interface IpcResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  // Stable, machine-readable failure identifier. Present on a small set
  // of handlers that need the renderer to branch on specific failures
  // (e.g. TUNNEL_DISABLED_BY_POLICY, CREDENTIAL_RESTORE_FAILED) without
  // depending on the English `error` string.
  code?: string
}

// Type-safe event listener creator
// Accepts a typed callback and safely converts it to the IPC handler format
function createEventListener<T = unknown>(
  channel: string,
  callback: (data: T) => void
): () => void {
  console.log(`[Preload] Creating event listener for channel: ${channel}`)

  const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
    console.log(`[Preload] Received event on channel: ${channel}`, data)
    callback(data as T)
  }

  ipcRenderer.on(channel, handler)

  return () => {
    console.log(`[Preload] Removing event listener for channel: ${channel}`)
    ipcRenderer.removeListener(channel, handler)
  }
}

/**
 * Derive preload invokers from a typed RPC contract: each exposed method
 * becomes `(...args) => ipcRenderer.invoke(channel, ...args)`. The return is
 * typed as the matching subset of {@link HaloAPI} (the contract's keys are
 * `window.halo.*` method names), so spreading it into the `api` object stays
 * fully typed against the existing surface — the channel name and arg order
 * can never drift from the contract, and no per-channel casting is needed.
 *
 * Behaviour is identical to the hand-written `ipcRenderer.invoke(...)` wrapper
 * it replaces; the `HaloAPI[K]` result types continue to come from the
 * interface declaration.
 *
 * ⚠️ ONLY valid for IDENTITY-ARG channels — i.e. ones whose hand-written
 * wrapper was `(...args) => invoke('ch', ...args)` (positional args passed
 * through unchanged). bindRpc spreads positional args, so any channel whose
 * wrapper TRANSFORMED args — packing into an object `(viewId, url) =>
 * invoke('ch', { viewId, url })`, reordering, or setting up a per-call
 * progress listener — MUST stay hand-written (see `browser:*`, `store:install`,
 * `git-bash:install`). The `as HaloAPI[K]` cast cannot detect this mismatch,
 * and esbuild does not type-check — so a wrong migration compiles green but
 * breaks at runtime. Verify the original wrapper is identity-form before
 * converting a channel to a contract.
 */
function bindRpc<C extends RpcContract>(contract: C): { [K in keyof C & keyof HaloAPI]: HaloAPI[K] } {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const name of Object.keys(contract)) {
    const { channel } = contract[name]
    out[name] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
  }
  return out as { [K in keyof C & keyof HaloAPI]: HaloAPI[K] }
}

// Expose API to renderer
const api: HaloAPI = {
  // Typed-RPC-derived bindings (see shared/rpc/contracts). Channel names and
  // argument shapes come from the contract — no manual sync needed.
  ...bindRpc(modelCapabilitiesRpc),

  // Generic Auth (provider-agnostic)
  ...bindRpc(authRpc),
  onAuthLoginProgress: (callback) => createEventListener('auth:login-progress', callback),

  // Config + AI Sources CRUD (derived from configRpc contract)
  ...bindRpc(configRpc),

  // CLI Config
  ...bindRpc(cliConfigRpc),

  // Space
  ...bindRpc(spaceRpc),

  // Conversation
  ...bindRpc(conversationRpc),

  // Agent (derived from agentRpc contract)
  ...bindRpc(agentRpc),

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
  onAgentTurnStart: (callback) => createEventListener('agent:turn-start', callback),

  // Artifact (methods derived from artifactRpc contract; event listeners kept)
  ...bindRpc(artifactRpc),
  onArtifactChanged: (callback) => createEventListener('artifact:changed', callback),
  onArtifactTreeUpdate: (callback) => createEventListener('artifact:tree-update', callback),

  // Onboarding (derived from onboardingRpc contract)
  ...bindRpc(onboardingRpc),

  // Remote Access
  ...bindRpc(remoteRpc),
  onRemoteStatusChange: (callback) => createEventListener('remote:status-change', callback),

  // Security policy
  ...bindRpc(securityRpc),

  // System Settings + Window controls (derived from systemRpc contract)
  ...bindRpc(systemRpc),
  onWindowMaximizeChange: (callback) => createEventListener('window:maximize-change', callback),

  // Search (methods derived from searchRpc contract; event listeners kept)
  ...bindRpc(searchRpc),
  onSearchProgress: (callback) => createEventListener('search:progress', callback),
  onSearchCancelled: (callback) => createEventListener('search:cancelled', callback),

  // Updater
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getVersion: () => ipcRenderer.invoke('updater:get-version'),
  onUpdaterStatus: (callback) => createEventListener('updater:status', callback),

  // Browser (embedded browser for Content Canvas).
  // NOTE: these preload methods PACK positional args into the object shape the
  // main handlers destructure (e.g. (viewId, url) -> { viewId, url }), so they
  // are kept hand-written — bindRpc's positional passthrough would break them.
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
  setBrowserDeviceMode: (viewId, mode) => ipcRenderer.invoke('browser:set-device-mode', { viewId, mode }),
  showBrowserContextMenu: (options) => ipcRenderer.invoke('browser:show-context-menu', options),
  openLoginWindow: (url, title) => ipcRenderer.invoke('browser:open-login-window', { url, title }),
  onBrowserStateChange: (callback) => createEventListener('browser:state-change', callback),
  onBrowserZoomChanged: (callback) => createEventListener('browser:zoom-changed', callback),

  // Canvas Tab Menu (native Electron menu)
  showCanvasTabContextMenu: (options) => ipcRenderer.invoke('canvas:show-tab-context-menu', options),
  onCanvasTabAction: (callback) => createEventListener('canvas:tab-action', callback),

  // AI Browser - active view change notification from main process
  onAIBrowserActiveViewChanged: (callback) => createEventListener('ai-browser:active-view-changed', callback),

  // Overlay (for floating UI above BrowserView)
  ...bindRpc(overlayRpc),
  onCanvasExitMaximized: (callback) => createEventListener('canvas:exit-maximized', callback),

  // Performance Monitoring (Developer Tools)
  ...bindRpc(perfRpc),
  perfReportRendererMetrics: (metrics) => ipcRenderer.send('perf:renderer-metrics', metrics),
  onPerfSnapshot: (callback) => createEventListener('perf:snapshot', callback),
  onPerfWarning: (callback) => createEventListener('perf:warning', callback),

  // Git Bash (Windows only) — getGitBashStatus + openExternal derived from
  // gitBashRpc; installGitBash keeps its custom per-call progress wrapper.
  ...bindRpc(gitBashRpc),
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

  // Bootstrap lifecycle
  getBootstrapStatus: () => ipcRenderer.invoke('bootstrap:get-status'),
  onBootstrapExtendedReady: (callback) => createEventListener('bootstrap:extended-ready', callback),

  // Health System
  ...bindRpc(healthRpc),

  // Notification Channels
  ...bindRpc(notificationChannelsRpc),

  // WeCom Bot (企业微信智能机器人) status + scan-auth (derived from wecomBotRpc)
  ...bindRpc(wecomBotRpc),

  // IM Channels (multi-instance)
  ...bindRpc(imChannelsRpc),

  // IM Sessions
  ...bindRpc(imSessionsRpc),

  // WeChat Personal Bot via iLink API
  ...bindRpc(weixinIlinkRpc),

  // Apps Management + Import/Export + Chat (all derived from appRpc contract)
  ...bindRpc(appRpc),

  // App Event Listeners
  onAppStatusChanged: (callback) => createEventListener('app:status_changed', callback),
  onAppActivityEntry: (callback) => createEventListener('app:activity_entry:new', callback),
  onAppEscalation: (callback) => createEventListener('app:escalation:new', callback),
  onAppNavigate: (callback) => createEventListener('app:navigate', callback),
  onImSessionUpdated: (callback) => createEventListener('app:im-session-updated', callback),
  onImChannelInstanceUpdated: (callback) => createEventListener('im-channels:instance-updated', callback),

  // Store (App Registry) — most methods derived from storeRpc contract;
  // storeInstall keeps its custom progress-listener wrapper below.
  ...bindRpc(storeRpc),
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
  onStoreSyncStatusChanged: (callback) => createEventListener('store:sync-status-changed', callback),

  // Notification (in-app toast)
  onNotificationToast: (callback) => createEventListener('notification:toast', callback),

  // Model Capabilities
  // modelCapabilities* are provided by `...bindRpc(modelCapabilitiesRpc)` above.

  // Telemetry (fire-and-forget)
  trackEvent: (event: string, properties?: Record<string, unknown>) => {
    ipcRenderer.send('analytics:report', { event, properties })
  },
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
