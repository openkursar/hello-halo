/**
 * Im REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  ILINK_BASE_URL,
  WecomScanAuthError,
  buildDefaultAssistantSpec,
  disconnectIlink,
  dispatchInboundMessage,
  fetchJson,
  getAppManager,
  getImChannelManager,
  getImSessionRegistry,
  getServiceConfig,
  saveIlinkToken,
  wecomGenerateScode,
  wecomPollResult,
} from './_shared'

export function registerImRoutes(app: Express): void {
  // ===== WeCom Bot Routes (legacy compat — delegates to ImChannelManager) =====

  app.get('/api/wecom-bot/status', async (req: Request, res: Response) => {
    try {
      const manager = getImChannelManager()
      if (!manager) {
        res.json({ success: true, data: { configured: false, enabled: false, connected: false } })
        return
      }
      const statuses = manager.getAllStatuses().filter(s => s.type === 'wecom-bot')
      res.json({
        success: true,
        data: {
          configured: statuses.length > 0,
          enabled: statuses.some(s => s.enabled),
          connected: statuses.some(s => s.connected),
        }
      })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/wecom-bot/reconnect', async (req: Request, res: Response) => {
    try {
      const manager = getImChannelManager()
      if (!manager) {
        res.status(503).json({ success: false, error: 'ImChannelManager not initialized' })
        return
      }
      for (const s of manager.getAllStatuses().filter(s => s.type === 'wecom-bot')) {
        manager.reconnectInstance(s.id)
      }
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })


  // ===== WeCom Bot — Scan-Auth Routes (QR-code device flow) =====
  // Implementation lives in src/main/apps/runtime/im-channels/wecom-bot-scan-auth.ts
  // and the IPC handler in src/main/ipc/wecom-bot.ts owns the per-scode AbortController
  // session map. These HTTP routes are thin shims for remote/Capacitor clients.
  //
  // Because Express-side session state needs to mirror the IPC-side AbortController map,
  // we re-import the helpers directly here and use a route-local map that is kept
  // separate from the IPC map (clients only see one transport at a time per scode).
  const wecomScanAuthHttpSessions = new Map<string, { abort: AbortController; startedAt: number }>()

  app.post('/api/wecom-bot/scan-auth/start', async (_req: Request, res: Response) => {
    try {
      const { scode, authUrl } = await wecomGenerateScode()
      const existing = wecomScanAuthHttpSessions.get(scode)
      if (existing) existing.abort.abort()
      wecomScanAuthHttpSessions.set(scode, { abort: new AbortController(), startedAt: Date.now() })
      res.json({ success: true, data: { scode, authUrl } })
    } catch (error) {
      const err = error instanceof WecomScanAuthError
        ? { success: false, error: error.message, kind: error.kind }
        : { success: false, error: (error as Error).message }
      res.json(err)
    }
  })

  app.post('/api/wecom-bot/scan-auth/poll', async (req: Request, res: Response) => {
    const scode = req.body?.scode as string | undefined
    if (!scode) {
      res.json({ success: false, error: 'Missing scode' })
      return
    }
    const session = wecomScanAuthHttpSessions.get(scode)
    if (!session) {
      res.json({ success: false, error: 'No active scan session', kind: 'expired' })
      return
    }
    try {
      const creds = await wecomPollResult(scode, { signal: session.abort.signal })
      res.json({ success: true, data: creds })
    } catch (error) {
      const err = error instanceof WecomScanAuthError
        ? { success: false, error: error.message, kind: error.kind }
        : { success: false, error: (error as Error).message }
      res.json(err)
    } finally {
      wecomScanAuthHttpSessions.delete(scode)
    }
  })

  app.post('/api/wecom-bot/scan-auth/cancel', async (req: Request, res: Response) => {
    const scode = req.body?.scode as string | undefined
    if (scode) {
      const session = wecomScanAuthHttpSessions.get(scode)
      if (session) {
        session.abort.abort()
        wecomScanAuthHttpSessions.delete(scode)
      }
    }
    res.json({ success: true })
  })

  app.post('/api/wecom-bot/scan-auth/create-assistant', async (req: Request, res: Response) => {
    try {
      const manager = getAppManager()
      if (!manager) {
        res.status(503).json({ success: false, error: 'AppManager not initialized' })
        return
      }
      const prefix = String(req.body?.botIdPrefix ?? '').slice(0, 8) || 'bot'
      const spec = buildDefaultAssistantSpec(prefix)
      const appId = await manager.install('halo-temp', spec)
      res.json({ success: true, data: { appId, appName: spec.name } })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })


  // ===== IM Channel Routes (multi-instance) =====

  // GET /api/im-channels/status — all instance statuses, or single instance when ?instanceId= is provided
  app.get('/api/im-channels/status', async (req: Request, res: Response) => {
    try {
      const manager = getImChannelManager()
      const instanceId = req.query.instanceId as string | undefined
      if (instanceId) {
        if (!manager) {
          res.json({ success: false, error: 'ImChannelManager not initialized' })
          return
        }
        const status = manager.getInstanceStatus(instanceId)
        if (!status) {
          res.json({ success: false, error: `Instance "${instanceId}" not found` })
          return
        }
        res.json({ success: true, data: status })
      } else {
        res.json({ success: true, data: manager?.getAllStatuses() ?? [] })
      }
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/im-channels/reconnect — reconnect a specific instance
  app.post('/api/im-channels/reconnect', async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.body
      if (!instanceId) {
        res.status(400).json({ success: false, error: 'instanceId is required' })
        return
      }
      const manager = getImChannelManager()
      if (!manager) {
        res.status(503).json({ success: false, error: 'ImChannelManager not initialized' })
        return
      }
      const ok = manager.reconnectInstance(instanceId)
      res.json({ success: ok, error: ok ? undefined : `Instance "${instanceId}" not found` })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/im-channels/reload — reload all instances from config
  app.post('/api/im-channels/reload', async (req: Request, res: Response) => {
    try {
      const manager = getImChannelManager()
      if (!manager) {
        res.status(503).json({ success: false, error: 'ImChannelManager not initialized' })
        return
      }
      const config = getServiceConfig()
      const instances = config.imChannels?.instances ?? []
      manager.applyConfig(instances, (instanceId: string, appId: string, msg: any, reply: any) => {
        dispatchInboundMessage(msg, reply, appId, instanceId)
      })
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/im-channels/providers — available provider types
  app.get('/api/im-channels/providers', async (req: Request, res: Response) => {
    try {
      const manager = getImChannelManager()
      const providers = manager?.getAllProviders().map(p => ({
        type: p.type,
        displayName: p.displayName,
        description: p.description,
        direction: p.direction,
        configFields: p.configFields,
        defaultConfig: p.defaultConfig,
      })) ?? []
      res.json({ success: true, data: providers })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/im-channels/permission-defaults — product-level permission defaults
  app.get('/api/im-channels/permission-defaults', async (req: Request, res: Response) => {
    try {
      const { getImChannelsPermissionDefaults } = await import('../../foundation/product-config')
      const defaults = getImChannelsPermissionDefaults()
      res.json({ success: true, data: defaults ?? null })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })


  // ===== WeChat iLink QR Auth Routes =====

  // POST /api/weixin-ilink/request-qrcode
  app.post('/api/weixin-ilink/request-qrcode', async (_req: Request, res: Response) => {
    try {
      // GET requests do NOT use auth headers (per iLink protocol)
      interface QrCodeResponse { qrcode?: string; qrcode_img_content?: string }
      const data = await fetchJson<QrCodeResponse>(
        'GET',
        `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
        {}
      )
      if (!data.qrcode) {
        res.json({ success: false, error: 'iLink API returned no qrcode token' })
        return
      }
      res.json({
        success: true,
        data: {
          qrcode: data.qrcode,
          qrcodeImgContent: data.qrcode_img_content ?? '',
          baseUrl: ILINK_BASE_URL,
        },
      })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/weixin-ilink/poll-auth-status
  app.post('/api/weixin-ilink/poll-auth-status', async (req: Request, res: Response) => {
    try {
      const { qrcode } = req.body as { qrcode?: string }
      if (!qrcode) {
        res.status(400).json({ success: false, error: 'qrcode is required' })
        return
      }
      // get_qrcode_status requires iLink-App-ClientVersion: 1 header (per protocol)
      interface QrStatusResponse {
        status?: 'wait' | 'scaned' | 'confirmed' | 'expired'
        bot_token?: string
        ilink_bot_id?: string
        baseurl?: string
        ilink_user_id?: string
      }
      const data = await fetchJson<QrStatusResponse>(
        'GET',
        `${ILINK_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        { 'iLink-App-ClientVersion': '1' }
      )
      res.json({
        success: true,
        data: {
          status: data.status ?? 'wait',
          botToken: data.bot_token,
          accountId: data.ilink_bot_id,
          baseUrl: data.baseurl,
          userId: data.ilink_user_id,
        },
      })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/weixin-ilink/save-token
  app.post('/api/weixin-ilink/save-token', async (req: Request, res: Response) => {
    try {
      const { instanceId, botToken, baseUrl, accountId } = req.body as {
        instanceId?: string; botToken?: string; baseUrl?: string; accountId?: string
      }
      const result = await saveIlinkToken(instanceId ?? '', botToken ?? '', baseUrl, accountId)
      if (!result.success) {
        res.status(400).json(result)
        return
      }
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/weixin-ilink/disconnect
  app.post('/api/weixin-ilink/disconnect', async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.body as { instanceId?: string }
      const result = await disconnectIlink(instanceId ?? '')
      if (!result.success) {
        res.status(400).json(result)
        return
      }
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })


  // ===== IM Sessions Routes =====

  // GET /api/im-sessions — list IM sessions, optional ?appId= filter
  app.get('/api/im-sessions', async (req: Request, res: Response) => {
    try {
      const registry = getImSessionRegistry()
      if (!registry) {
        res.json({ success: true, data: [] })
        return
      }
      const appId = typeof req.query.appId === 'string' ? req.query.appId : undefined
      const sessions = appId ? registry.getAllSessions(appId) : registry.listAll()
      res.json({ success: true, data: sessions })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/im-sessions/set-proactive — toggle a session's auto-sync flag.
  // When proactive=true, the run's final assistant text is pushed to this
  // contact at run completion (apps/runtime/im-auto-sync.ts). Used by the
  // remote web client; desktop goes through IPC.
  app.post('/api/im-sessions/set-proactive', async (req: Request, res: Response) => {
    try {
      const registry = getImSessionRegistry()
      if (!registry) {
        res.status(503).json({ success: false, error: 'IM session registry not initialized' })
        return
      }
      const { appId, channel, chatId, proactive } = req.body as {
        appId: string
        channel: string
        chatId: string
        proactive: boolean
      }
      const updated = registry.setProactive(appId, channel, chatId, proactive)
      if (!updated) {
        res.status(404).json({ success: false, error: 'Session not found' })
        return
      }
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/im-sessions/remove — remove a session from the registry
  app.post('/api/im-sessions/remove', async (req: Request, res: Response) => {
    try {
      const registry = getImSessionRegistry()
      if (!registry) {
        res.status(503).json({ success: false, error: 'IM session registry not initialized' })
        return
      }
      const { appId, channel, chatId } = req.body as {
        appId: string
        channel: string
        chatId: string
      }
      const removed = registry.removeSession(appId, channel, chatId)
      res.json({ success: true, data: { removed } })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/im-sessions/set-custom-name — set custom display name for a session
  app.post('/api/im-sessions/set-custom-name', async (req: Request, res: Response) => {
    try {
      const registry = getImSessionRegistry()
      if (!registry) {
        res.status(503).json({ success: false, error: 'IM session registry not initialized' })
        return
      }
      const { appId, channel, chatId, name } = req.body as {
        appId: string
        channel: string
        chatId: string
        name: string
      }
      const updated = registry.setCustomName(appId, channel, chatId, name)
      if (!updated) {
        res.status(404).json({ success: false, error: 'Session not found' })
        return
      }
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

}
