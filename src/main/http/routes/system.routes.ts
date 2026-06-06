/**
 * System REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  analytics,
  electronApp,
  getEnabledAuthProviderConfigs,
} from './_shared'

export function registerSystemRoutes(app: Express): void {
  // ===== Auth Routes (Read-only for remote access) =====
  // Remote clients use host machine's auth state, no login operations needed
  app.get('/api/auth/providers', async (req: Request, res: Response) => {
    try {
      const providers = getEnabledAuthProviderConfigs()
      res.json({ success: true, data: providers })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })


  // ===== System Routes =====
  app.get('/api/system/version', async (req: Request, res: Response) => {
    try {
      const version = electronApp.getVersion()
      res.json({ success: true, data: version })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })


  // ===== Analytics =====
  // POST /api/analytics/report — fire-and-forget telemetry from remote/Capacitor clients
  app.post('/api/analytics/report', (req: Request, res: Response) => {
    try {
      const { event, properties } = req.body as {
        event?: string
        properties?: Record<string, unknown>
      }

      if (!event || typeof event !== 'string') {
        res.status(400).json({ success: false, error: 'Missing event name' })
        return
      }

      // Delegate to the same analytics pipeline the IPC handler uses
      void analytics.track(event, properties ?? {})

      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })
}
