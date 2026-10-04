/**
 * Code review REST API routes (remote access).
 * Mirrors the IPC code-review surface (ipc/code-review.ts) through the same
 * controller: start a review, read the latest one, team availability.
 */
import type { Express, Request, Response } from 'express'
import * as codeReviewController from '../../controllers/code-review.controller'

function fail(res: Response, error: unknown): void {
  res.json({ success: false, error: error instanceof Error ? error.message : String(error) })
}

export function registerCodeReviewRoutes(app: Express): void {
  app.post('/api/code-review/start', async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await codeReviewController.startCodeReview(req.body) })
    } catch (error) {
      fail(res, error)
    }
  })

  app.get('/api/code-review/latest', async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: codeReviewController.getLatestCodeReview(req.query.spaceId, req.query.repoRoot) })
    } catch (error) {
      fail(res, error)
    }
  })

  app.get('/api/code-review/availability', async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: codeReviewController.getCodeReviewAvailability() })
    } catch (error) {
      fail(res, error)
    }
  })
}
