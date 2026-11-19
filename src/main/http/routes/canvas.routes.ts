/**
 * Canvas REST routes (remote access): a remote client's answer to the AI's
 * request to bring something in front of the user (desktop: canvas:show-reply).
 */
import type { Express, Request, Response } from 'express'

export function registerCanvasRoutes(app: Express): void {
  app.post('/api/canvas/show-reply', async (req: Request, res: Response) => {
    try {
      const { receiveCanvasShowReply } = await import('../../services/canvas-show')
      res.json({ success: receiveCanvasShowReply(req.body) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })
}
