/**
 * AI Browser REST routes (remote access): the pages AI conversations hold, so a
 * remote client that connects late shows the same AI tabs as the desktop
 * (desktop: ai-browser:list-live-pages). Remote clients cannot display or end
 * those pages; they show them as tabs only.
 */
import type { Express, Request, Response } from 'express'

export function registerAIBrowserRoutes(app: Express): void {
  app.get('/api/ai-browser/live-pages', async (_req: Request, res: Response) => {
    try {
      const { listLivePages } = await import('../../services/ai-browser')
      res.json({ success: true, data: listLivePages() })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })
}
