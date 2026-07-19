/**
 * Space REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  conversationController,
  getSpacesDir,
  spaceController,
} from './_shared'

export function registerSpaceRoutes(app: Express): void {
  // ===== Space Routes =====
  app.get('/api/spaces/halo', async (req: Request, res: Response) => {
    const result = spaceController.getHaloTempSpace()
    res.json(result)
  })

  // Get default space path (must be before :spaceId route)
  app.get('/api/spaces/default-path', async (req: Request, res: Response) => {
    try {
      const spacesDir = getSpacesDir()
      res.json({ success: true, data: spacesDir })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.get('/api/spaces', async (req: Request, res: Response) => {
    const result = spaceController.listSpaces()
    res.json(result)
  })

  app.post('/api/spaces', async (req: Request, res: Response) => {
    const { name, icon, customPath } = req.body
    const result = spaceController.createSpace({ name, icon, customPath })
    res.json(result)
  })

  // Reorder spaces — must be before :spaceId route to avoid matching "reorder" as an id
  app.put('/api/spaces/reorder', async (req: Request, res: Response) => {
    const { spaceIds } = req.body
    const result = spaceController.reorderSpaces(Array.isArray(spaceIds) ? spaceIds : [])
    res.json(result)
  })

  app.get('/api/spaces/:spaceId', async (req: Request, res: Response) => {
    const result = spaceController.getSpace(req.params.spaceId)
    res.json(result)
  })

  app.put('/api/spaces/:spaceId', async (req: Request, res: Response) => {
    const result = spaceController.updateSpace(req.params.spaceId, req.body)
    res.json(result)
  })

  app.delete('/api/spaces/:spaceId', async (req: Request, res: Response) => {
    const result = await spaceController.deleteSpace(req.params.spaceId)
    res.json(result)
  })

  // Note: openSpaceFolder doesn't make sense for remote access
  // We could return the path instead
  app.post('/api/spaces/:spaceId/open', async (req: Request, res: Response) => {
    // For remote access, just return the path
    const space = spaceController.getSpace(req.params.spaceId)
    if (space.success && space.data) {
      res.json({ success: true, data: { path: (space.data as any).path } })
    } else {
      res.json(space)
    }
  })


  // ===== Conversation Routes =====
  app.get('/api/spaces/:spaceId/conversations', async (req: Request, res: Response) => {
    const result = conversationController.listConversations(req.params.spaceId)
    res.json(result)
  })

  app.post('/api/spaces/:spaceId/conversations', async (req: Request, res: Response) => {
    const { title } = req.body
    const result = conversationController.createConversation(req.params.spaceId, title)
    res.json(result)
  })

  app.get('/api/spaces/:spaceId/conversations/:conversationId', async (req: Request, res: Response) => {
    const result = conversationController.getConversation(
      req.params.spaceId,
      req.params.conversationId
    )
    res.json(result)
  })

  app.put('/api/spaces/:spaceId/conversations/:conversationId', async (req: Request, res: Response) => {
    const result = conversationController.updateConversation(
      req.params.spaceId,
      req.params.conversationId,
      req.body
    )
    res.json(result)
  })

  app.delete('/api/spaces/:spaceId/conversations/:conversationId', async (req: Request, res: Response) => {
    const result = conversationController.deleteConversation(
      req.params.spaceId,
      req.params.conversationId
    )
    res.json(result)
  })

  app.post('/api/spaces/:spaceId/conversations/:conversationId/messages', async (req: Request, res: Response) => {
    const result = conversationController.addMessage(
      req.params.spaceId,
      req.params.conversationId,
      req.body
    )
    res.json(result)
  })

  app.put('/api/spaces/:spaceId/conversations/:conversationId/messages/last', async (req: Request, res: Response) => {
    const result = conversationController.updateLastMessage(
      req.params.spaceId,
      req.params.conversationId,
      req.body
    )
    res.json(result)
  })

  app.get('/api/spaces/:spaceId/conversations/:conversationId/messages/:messageId/thoughts', async (req: Request, res: Response) => {
    const result = conversationController.getMessageThoughts(
      req.params.spaceId,
      req.params.conversationId,
      req.params.messageId
    )
    res.json(result)
  })

  // Toggle starred status
  app.post('/api/spaces/:spaceId/conversations/:conversationId/star', async (req: Request, res: Response) => {
    const { starred } = req.body
    const result = conversationController.toggleStarConversation(
      req.params.spaceId,
      req.params.conversationId,
      starred
    )
    res.json(result)
  })

}
