/**
 * imApi — im domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const imApi = {
  // ===== WeCom Bot (legacy compat) =====
  getWecomBotStatus: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getWecomBotStatus()
    }
    return httpRequest('GET', '/api/wecom-bot/status')
  },

  reconnectWecomBot: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.reconnectWecomBot()
    }
    return httpRequest('POST', '/api/wecom-bot/reconnect')
  },

  // ===== WeCom Bot — Scan-Auth (QR-code device flow) =====
  wecomBotScanAuthStart: async (): Promise<ApiResponse<{ scode: string; authUrl: string }>> => {
    if (isElectron()) {
      return window.halo.wecomBotScanAuthStart()
    }
    return httpRequest('POST', '/api/wecom-bot/scan-auth/start')
  },

  wecomBotScanAuthPoll: async (
    scode: string,
  ): Promise<ApiResponse<{ botId: string; secret: string }> & { kind?: string }> => {
    if (isElectron()) {
      return window.halo.wecomBotScanAuthPoll(scode)
    }
    return httpRequest('POST', '/api/wecom-bot/scan-auth/poll', { scode })
  },

  wecomBotScanAuthCancel: async (scode: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.wecomBotScanAuthCancel(scode)
    }
    return httpRequest('POST', '/api/wecom-bot/scan-auth/cancel', { scode })
  },

  wecomBotScanAuthCreateAssistant: async (
    input: { botIdPrefix: string },
  ): Promise<ApiResponse<{ appId: string; appName: string }>> => {
    if (isElectron()) {
      return window.halo.wecomBotScanAuthCreateAssistant(input)
    }
    return httpRequest('POST', '/api/wecom-bot/scan-auth/create-assistant', input)
  },

  // ===== IM Channels (multi-instance) =====
  imChannelsStatus: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imChannelsStatus()
    }
    return httpRequest('GET', '/api/im-channels/status')
  },

  imChannelsInstanceStatus: async (instanceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imChannelsInstanceStatus(instanceId)
    }
    return httpRequest('GET', `/api/im-channels/status?instanceId=${encodeURIComponent(instanceId)}`)
  },

  imChannelsReconnect: async (instanceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imChannelsReconnect(instanceId)
    }
    return httpRequest('POST', '/api/im-channels/reconnect', { instanceId })
  },

  imChannelsReload: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imChannelsReload()
    }
    return httpRequest('POST', '/api/im-channels/reload')
  },

  imChannelsProviders: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imChannelsProviders()
    }
    return httpRequest('GET', '/api/im-channels/providers')
  },

  imChannelsPermissionDefaults: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imChannelsPermissionDefaults()
    }
    return httpRequest('GET', '/api/im-channels/permission-defaults')
  },

  // ===== WeChat Personal Bot via iLink API =====
  weixinIlinkRequestQrcode: async (): Promise<ApiResponse<{ qrcode: string; qrcodeImgContent: string; baseUrl: string }>> => {
    if (isElectron()) {
      return window.halo.weixinIlinkRequestQrcode()
    }
    return httpRequest('POST', '/api/weixin-ilink/request-qrcode')
  },

  weixinIlinkPollAuthStatus: async (qrcode: string): Promise<ApiResponse<{ status: 'wait' | 'scaned' | 'confirmed' | 'expired'; botToken?: string; accountId?: string; baseUrl?: string; userId?: string }>> => {
    if (isElectron()) {
      return window.halo.weixinIlinkPollAuthStatus(qrcode)
    }
    return httpRequest('POST', '/api/weixin-ilink/poll-auth-status', { qrcode })
  },

  weixinIlinkSaveToken: async (instanceId: string, botToken: string, baseUrl?: string, accountId?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.weixinIlinkSaveToken(instanceId, botToken, baseUrl, accountId)
    }
    return httpRequest('POST', '/api/weixin-ilink/save-token', { instanceId, botToken, baseUrl, accountId })
  },

  weixinIlinkDisconnect: async (instanceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.weixinIlinkDisconnect(instanceId)
    }
    return httpRequest('POST', '/api/weixin-ilink/disconnect', { instanceId })
  },

  // ===== IM Sessions =====
  imSessionsList: async (appId?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imSessionsList(appId)
    }
    const path = appId ? `/api/im-sessions?appId=${encodeURIComponent(appId)}` : '/api/im-sessions'
    return httpRequest('GET', path)
  },

  imSessionsSetProactive: async (input: { appId: string; channel: string; chatId: string; proactive: boolean }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imSessionsSetProactive(input)
    }
    return httpRequest('POST', '/api/im-sessions/set-proactive', input)
  },

  imSessionsRemove: async (input: { appId: string; channel: string; chatId: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imSessionsRemove(input)
    }
    return httpRequest('POST', '/api/im-sessions/remove', input)
  },

  imSessionsSetCustomName: async (input: { appId: string; channel: string; chatId: string; name: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.imSessionsSetCustomName(input)
    }
    return httpRequest('POST', '/api/im-sessions/set-custom-name', input)
  },

}
