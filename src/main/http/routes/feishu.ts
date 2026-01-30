/**
 * Feishu Routes - Webhook endpoints for Feishu bot integration
 * These routes are registered BEFORE auth middleware (public endpoints)
 */

import { Express, Request, Response } from 'express'
import * as feishuController from '../../controllers/feishu.controller'
import { FeishuMessageEvent } from '../../controllers/feishu.controller'

// Default space and conversation for Feishu messages
// TODO: Make this configurable via settings
const DEFAULT_SPACE_ID = 'halo-temp'
const DEFAULT_CONVERSATION_ID = 'feishu-default'

interface UrlVerificationRequest {
  type: 'url_verification'
  challenge: string
  token?: string
}

interface EventCallbackRequest {
  schema?: string
  header?: {
    event_type: string
    event_id: string
  }
  event?: unknown
}

type FeishuWebhookRequest = UrlVerificationRequest | EventCallbackRequest

/**
 * Register Feishu webhook routes (public, no auth required)
 */
export function registerFeishuRoutes(app: Express): void {
  // Health check for Feishu integration
  app.get('/api/feishu/status', (req: Request, res: Response) => {
    const configured = feishuController.isFeishuConfigured()
    const config = feishuController.getFeishuConfig()
    res.json({
      success: true,
      data: {
        configured,
        enabled: config.enabled,
        message: configured
          ? 'Feishu integration is configured'
          : 'Missing App ID or App Secret'
      }
    })
  })

  // Get Feishu config (hide secret)
  app.get('/api/feishu/config', (req: Request, res: Response) => {
    const config = feishuController.getFeishuConfig()
    res.json({
      success: true,
      data: {
        appId: config.appId,
        hasSecret: !!config.appSecret,
        enabled: config.enabled
      }
    })
  })

  // Save Feishu config
  app.post('/api/feishu/config', (req: Request, res: Response) => {
    const { appId, appSecret, enabled } = req.body
    const result = feishuController.saveFeishuConfig({ appId, appSecret, enabled })
    res.json(result)
  })

  // Main webhook endpoint for Feishu events
  app.post('/api/feishu/webhook', async (req: Request, res: Response) => {
    try {
      const body = req.body as FeishuWebhookRequest

      // Handle URL verification (Feishu sends this when configuring webhook)
      if ('type' in body && body.type === 'url_verification') {
        console.log('[Feishu] URL verification request received')
        const result = feishuController.handleUrlVerification(body.challenge)
        // Feishu expects { challenge: "xxx" } directly
        res.json(result.data)
        return
      }

      // Handle event callbacks
      if ('header' in body && body.header) {
        const eventType = body.header.event_type

        // Handle message events
        if (eventType === 'im.message.receive_v1') {
          console.log('[Feishu] Message event received')

          // Process asynchronously to respond quickly
          // Feishu requires response within 3 seconds
          setImmediate(async () => {
            try {
              await feishuController.handleMessageEvent(
                body as unknown as FeishuMessageEvent,
                DEFAULT_SPACE_ID,
                DEFAULT_CONVERSATION_ID
              )
            } catch (error) {
              console.error('[Feishu] Async message handling error:', error)
            }
          })

          // Respond immediately
          res.json({ success: true })
          return
        }

        // Log unhandled event types
        console.log(`[Feishu] Unhandled event type: ${eventType}`)
        res.json({ success: true })
        return
      }

      // Unknown request format
      console.warn('[Feishu] Unknown request format:', JSON.stringify(body).substring(0, 200))
      res.json({ success: true })
    } catch (error) {
      console.error('[Feishu] Webhook error:', error)
      // Always return 200 to prevent Feishu from retrying
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Manual send message endpoint (for testing)
  app.post('/api/feishu/send', async (req: Request, res: Response) => {
    try {
      const { chatId, message } = req.body

      if (!chatId || !message) {
        res.status(400).json({ success: false, error: 'Missing chatId or message' })
        return
      }

      const result = await feishuController.sendFeishuMessage(chatId, message)
      res.json(result)
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  console.log('[HTTP] Feishu routes registered')
}
