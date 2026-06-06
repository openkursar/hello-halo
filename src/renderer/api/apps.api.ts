/**
 * appsApi — apps domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  getAppChatConversationId,
  httpRequest,
  isElectron,
  onEvent,
  subscribeToConversation,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const appsApi = {
  // ===== Apps =====
  appList: async (filter?: { spaceId?: string; status?: string; type?: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appList(filter)
    }
    const params = new URLSearchParams()
    if (filter?.spaceId) params.set('spaceId', filter.spaceId)
    if (filter?.status) params.set('status', filter.status)
    if (filter?.type) params.set('type', filter.type)
    const qs = params.toString()
    return httpRequest('GET', `/api/apps${qs ? '?' + qs : ''}`)
  },

  appGet: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGet(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}`)
  },

  appInstall: async (input: { spaceId: string | null; spec: unknown; userConfig?: Record<string, unknown> }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appInstall(input)
    }
    return httpRequest('POST', '/api/apps/install', input as Record<string, unknown>)
  },

  appUninstall: async (appId: string, options?: { purge?: boolean }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUninstall({ appId, options })
    }
    const qs = options?.purge ? '?purge=true' : ''
    return httpRequest('DELETE', `/api/apps/${appId}${qs}`)
  },

  appReinstall: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appReinstall({ appId })
    }
    return httpRequest('POST', `/api/apps/${appId}/reinstall`)
  },

  appDelete: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appDelete({ appId })
    }
    return httpRequest('DELETE', `/api/apps/${appId}/permanent`)
  },

  appPause: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appPause(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/pause`)
  },

  appResume: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appResume(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/resume`)
  },

  appTrigger: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appTrigger(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/trigger`)
  },

  appGetState: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGetState(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}/state`)
  },

  appGetActivity: async (appId: string, options?: { limit?: number; offset?: number; type?: string; since?: number }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGetActivity({ appId, options })
    }
    const params = new URLSearchParams()
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    if (options?.since) params.set('before', String(options.since))
    const qs = params.toString()
    return httpRequest('GET', `/api/apps/${appId}/activity${qs ? '?' + qs : ''}`)
  },

  appGetSession: async (appId: string, runId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGetSession({ appId, runId })
    }
    return httpRequest('GET', `/api/apps/${appId}/runs/${runId}/session`)
  },

  appRespondEscalation: async (appId: string, escalationId: string, response: { choice?: string; text?: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appRespondEscalation({
        appId,
        escalationId,
        response: { ts: Date.now(), ...response },
      })
    }
    return httpRequest('POST', `/api/apps/${appId}/escalation/${escalationId}/respond`, response as Record<string, unknown>)
  },

  appContinueRun: async (appId: string, runId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appContinueRun({ appId, runId })
    }
    return httpRequest('POST', `/api/apps/${appId}/runs/${runId}/continue`)
  },

  appUpdateConfig: async (appId: string, config: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUpdateConfig({ appId, config })
    }
    return httpRequest('POST', `/api/apps/${appId}/config`, config)
  },

  appUpdateFrequency: async (appId: string, subscriptionId: string, frequency: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUpdateFrequency({ appId, subscriptionId, frequency })
    }
    return httpRequest('POST', `/api/apps/${appId}/frequency`, { subscriptionId, frequency })
  },

  appUpdateOverrides: async (appId: string, overrides: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUpdateOverrides({ appId, overrides })
    }
    // JSON serialization strips `undefined` values. Convert them to `null` so the server
    // can apply JSON Merge Patch semantics (null = delete key, e.g. reset model to global).
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(overrides)) {
      patch[key] = value === undefined ? null : value
    }
    return httpRequest('PATCH', `/api/apps/${appId}/overrides`, patch)
  },

  appUpdateSpec: async (appId: string, specPatch: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appUpdateSpec({ appId, specPatch })
    }
    return httpRequest('PATCH', `/api/apps/${appId}/spec`, specPatch)
  },

  appGrantPermission: async (appId: string, permission: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appGrantPermission({ appId, permission })
    }
    return httpRequest('POST', `/api/apps/${appId}/permissions/grant`, { permission })
  },

  appRevokePermission: async (appId: string, permission: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appRevokePermission({ appId, permission })
    }
    return httpRequest('POST', `/api/apps/${appId}/permissions/revoke`, { permission })
  },

  // App Import / Export
  appExportSpec: async (appId: string): Promise<ApiResponse<{ yaml: string; filename: string }>> => {
    if (isElectron()) {
      return window.halo.appExportSpec(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}/export-spec`)
  },

  appImportSpec: async (input: { spaceId: string; yamlContent: string; userConfig?: Record<string, unknown> }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appImportSpec(input)
    }
    return httpRequest('POST', '/api/apps/import-spec', input as Record<string, unknown>)
  },

  appOpenSkillFolder: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appOpenSkillFolder(appId)
    }
    // No filesystem access in web mode
    return { success: false, error: 'Not supported outside Electron' }
  },

  appGetDataPath: async (appId: string): Promise<ApiResponse<{ path: string }>> => {
    if (isElectron()) {
      return window.halo.appGetDataPath(appId)
    }
    // No filesystem access in web mode
    return { success: false, error: 'Not supported outside Electron' }
  },

  appOpenDataFolder: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appOpenDataFolder(appId)
    }
    // No filesystem access in web mode
    return { success: false, error: 'Not supported outside Electron' }
  },

  appClearMemory: async (appId: string): Promise<ApiResponse<{ filesRemoved: number }>> => {
    if (isElectron()) {
      return window.halo.appClearMemory(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/clear-memory`)
  },

  appMoveSpace: async (appId: string, newSpaceId: string | null): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appMoveSpace({ appId, newSpaceId })
    }
    return httpRequest('POST', `/api/apps/${appId}/move-space`, { newSpaceId })
  },

  // App Chat
  appChatSend: async (request: { appId: string; spaceId: string; message: string; images?: Array<{ type: string; media_type: string; data: string }>; thinkingEnabled?: boolean }): Promise<ApiResponse> => {
    // Subscribe to agent events so remote/Capacitor clients receive streaming updates.
    // The view also subscribes on mount (via useRemoteSubscription), but the API-level
    // subscription mirrors sendMessage's pattern and ensures coverage if the API is
    // called before the view mounts (e.g. programmatic triggers).
    if (!isElectron()) {
      subscribeToConversation(getAppChatConversationId(request.appId))
    }

    if (isElectron()) {
      return window.halo.appChatSend(request)
    }
    return httpRequest('POST', `/api/apps/${request.appId}/chat/send`, request as unknown as Record<string, unknown>)
  },

  appChatStop: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatStop(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/chat/stop`)
  },

  appChatStatus: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatStatus(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}/chat/status`)
  },

  appChatMessages: async (appId: string, spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatMessages({ appId, spaceId })
    }
    return httpRequest('GET', `/api/apps/${appId}/chat/messages?spaceId=${spaceId}`)
  },

  appChatSessionState: async (appId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatSessionState(appId)
    }
    return httpRequest('GET', `/api/apps/${appId}/chat/session-state`)
  },

  appChatClear: async (appId: string, spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appChatClear({ appId, spaceId })
    }
    return httpRequest('POST', `/api/apps/${appId}/chat/clear`, { spaceId })
  },

  appChatRestart: async (appId: string): Promise<ApiResponse<{ sessionsClosed: number }>> => {
    if (isElectron()) {
      return window.halo.appChatRestart(appId)
    }
    return httpRequest('POST', `/api/apps/${appId}/chat/restart`)
  },

  appImChatMessages: async (appId: string, spaceId: string, channel: string, chatType: 'direct' | 'group', chatId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appImChatMessages({ appId, spaceId, channel, chatType, chatId })
    }
    return httpRequest('GET', `/api/apps/${appId}/im-chat/messages?spaceId=${spaceId}&channel=${encodeURIComponent(channel)}&chatType=${chatType}&chatId=${encodeURIComponent(chatId)}`)
  },

  appImChatClear: async (appId: string, spaceId: string, channel: string, chatType: 'direct' | 'group', chatId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.appImChatClear({ appId, spaceId, channel, chatType, chatId })
    }
    return httpRequest('POST', `/api/apps/${appId}/im-chat/clear`, { spaceId, channel, chatType, chatId })
  },

  // App Event Listeners
  onAppStatusChanged: (callback: (data: unknown) => void) =>
    onEvent('app:status_changed', callback),

  onAppActivityEntry: (callback: (data: unknown) => void) =>
    onEvent('app:activity_entry:new', callback),

  onAppEscalation: (callback: (data: unknown) => void) =>
    onEvent('app:escalation:new', callback),

  onAppNavigate: (callback: (data: unknown) => void) =>
    onEvent('app:navigate', callback),

  onImSessionUpdated: (callback: (data: unknown) => void) =>
    onEvent('app:im-session-updated', callback),

  /**
   * Subscribe to main-initiated IM channel instance config mutations.
   *
   * Fires when the main process writes a change to an instance's persisted
   * config without renderer involvement — currently used by the WeCom bot
   * scan-auth owner auto-claim flow. Payload: `{ instanceId, instance }`.
   */
  onImChannelInstanceUpdated: (callback: (data: unknown) => void) =>
    onEvent('im-channels:instance-updated', callback),

}
