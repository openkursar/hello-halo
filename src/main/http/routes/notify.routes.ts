/**
 * Notify REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  clearAllTokenCaches,
  getServiceConfig,
  testChannel,
} from './_shared'
import type {
  NotificationChannelType,
} from './_shared'

export function registerNotifyRoutes(app: Express): void {
  // ===== Notification Channels Routes =====
  app.post('/api/notify-channels/test', async (req: Request, res: Response) => {
    try {
      const { channelType } = req.body as { channelType?: string }
      if (!channelType) {
        res.status(400).json({ success: false, error: 'Missing channelType' })
        return
      }
      const config = getServiceConfig()
      const channelsConfig = config.notificationChannels
      if (!channelsConfig) {
        res.json({ success: false, error: 'No notification channels configured' })
        return
      }
      const result = await testChannel(channelType as NotificationChannelType, channelsConfig)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/notify-channels/clear-cache', async (req: Request, res: Response) => {
    try {
      clearAllTokenCaches()
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

}
