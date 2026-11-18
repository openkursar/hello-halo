/**
 * Browser REST API routes (remote access).
 *
 * What a remote client needs of the browser: the pages it can watch, and
 * answering a page that is waiting for text the model must not hold — a PIN,
 * a one-time code. The page itself is driven by the AI browser tools in the
 * main process; nothing here creates, navigates or reads a page.
 *
 * Why the credential routes are remote-reachable at all: the person who holds
 * the code is not necessarily sitting at the desktop app, and the alternative
 * — typing it into the chat — is exactly what this feature exists to avoid.
 *
 * Every route is `expose: 'internal'`, so the self-API scope denies the model
 * access: it must not be able to enumerate pending requests or answer one on
 * the user's behalf. Office-member credentials are denied by the default-deny
 * route scope.
 *
 * Server mode only. A desktop hosts its pages on its own screen and answers
 * through IPC; its remote clients keep the plain link fallback.
 */
import type { Express, NextFunction, Request, Response } from 'express'
import { isServerMode } from '../../foundation/runtime-mode'

function serverOnly(_req: Request, res: Response, next: NextFunction): void {
  if (isServerMode()) return next()
  res.json({ success: false, error: 'The browser live view is only available on a Halo server' })
}

export function registerBrowserRoutes(app: Express): void {
  app.use('/api/browser', serverOnly)

  // Events only fire on change, so a remote client that connected after the AI
  // opened a page learns of it only from this snapshot.
  app.get('/api/browser/live-pages', async (_req: Request, res: Response) => {
    try {
      const { listLivePages } = await import('../../services/ai-browser')
      res.json({ success: true, data: listLivePages() })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.get('/api/browser/credential-requests', async (_req: Request, res: Response) => {
    try {
      const { listPendingCredentialRequests } = await import('../../services/ai-browser')
      res.json({ success: true, data: listPendingCredentialRequests() })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/browser/credential-requests/submit', async (req: Request, res: Response) => {
    try {
      const requestId = req.body?.requestId
      const values = req.body?.values
      if (typeof requestId !== 'string' || typeof values !== 'object' || values === null) {
        return res.json({ success: false, error: 'requestId and values (object) are required' })
      }
      const { submitCredential } = await import('../../services/ai-browser')
      const result = submitCredential(requestId, values as Record<string, string>)
      res.json(result.accepted ? { success: true } : { success: false, error: result.error })
    } catch (error) {
      // The message must stay free of the submitted values.
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/browser/credential-requests/decline', async (req: Request, res: Response) => {
    try {
      if (typeof req.body?.requestId !== 'string') {
        return res.json({ success: false, error: 'requestId is required' })
      }
      const { declineCredential } = await import('../../services/ai-browser')
      const result = declineCredential(req.body.requestId)
      res.json(result.accepted ? { success: true } : { success: false, error: result.error })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })
}
