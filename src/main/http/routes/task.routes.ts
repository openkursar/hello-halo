/**
 * Task state REST API routes (remote access).
 * Mirrors the IPC API for this domain (ipc/task.ts).
 */
import type { Express, Request, Response } from 'express'
import { taskController } from './_shared'

export function registerTaskRoutes(app: Express): void {
  app.get('/api/task-state', async (req: Request, res: Response) => {
    const result = taskController.listTaskState()
    res.json(result)
  })

  app.post('/api/task-state/mark-unseen', async (req: Request, res: Response) => {
    const { conversationId, spaceId, title } = req.body
    const result = taskController.markTaskUnseen(conversationId, spaceId, title)
    res.json(result)
  })

  app.post('/api/task-state/mark-read', async (req: Request, res: Response) => {
    const { conversationId, spaceId, title, originalStatus } = req.body
    const result = taskController.markTaskRead(conversationId, spaceId, title, originalStatus)
    res.json(result)
  })

  app.post('/api/task-state/set-kept', async (req: Request, res: Response) => {
    const { conversationId, kept } = req.body
    const result = taskController.setTaskKept(conversationId, kept)
    res.json(result)
  })

  app.post('/api/task-state/remove', async (req: Request, res: Response) => {
    const { conversationId } = req.body
    const result = taskController.removeTaskState(conversationId)
    res.json(result)
  })
}
