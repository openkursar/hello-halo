/**
 * Agent REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  agentController,
} from './_shared'

export function registerAgentRoutes(app: Express): void {
  // ===== Agent Routes =====
  app.post('/api/agent/message', async (req: Request, res: Response) => {
    const { spaceId, conversationId, message, resumeSessionId, images, thinkingEnabled } = req.body
    const result = await agentController.sendMessage({
      spaceId,
      conversationId,
      message,
      resumeSessionId,
      images,  // Pass images for multi-modal messages (remote access)
      thinkingEnabled  // Pass thinking mode for extended thinking (remote access)
    })
    res.json(result)
  })

  app.post('/api/agent/stop', async (req: Request, res: Response) => {
    const { conversationId } = req.body
    const result = agentController.stopGeneration(conversationId)
    res.json(result)
  })

  app.post('/api/agent/approve', async (req: Request, res: Response) => {
    const { conversationId } = req.body
    const result = agentController.approveTool(conversationId)
    res.json(result)
  })

  app.post('/api/agent/reject', async (req: Request, res: Response) => {
    const { conversationId } = req.body
    const result = agentController.rejectTool(conversationId)
    res.json(result)
  })

  app.get('/api/agent/sessions', async (req: Request, res: Response) => {
    const result = agentController.listActiveSessions()
    res.json(result)
  })

  app.get('/api/agent/generating/:conversationId', async (req: Request, res: Response) => {
    const result = agentController.checkGenerating(req.params.conversationId)
    res.json(result)
  })

  // Get session state for recovery after refresh
  app.get('/api/agent/session/:conversationId', async (req: Request, res: Response) => {
    const result = agentController.getSessionState(req.params.conversationId)
    res.json(result)
  })

  // Answer a pending AskUserQuestion
  app.post('/api/agent/answer-question', async (req: Request, res: Response) => {
    const { conversationId, id, answers } = req.body
    const result = agentController.answerQuestion(conversationId, id, answers)
    res.json(result)
  })

  // Test MCP server connections
  app.post('/api/agent/test-mcp', async (req: Request, res: Response) => {
    const result = await agentController.testMcpConnections()
    res.json(result)
  })

  // Engine capabilities — used by remote / Capacitor clients to mirror
  // the IPC surface added in `ipc/agent.ts`. The controller is left for
  // a future commit; we read the SDK directly to avoid drag-along
  // refactors here.
  app.get('/api/agent/engine-capabilities', async (_req: Request, res: Response) => {
    try {
      const { getEngineCapabilities, getActiveEngine } = await import('../../services/agent/resolved-sdk')
      const { defaultCapabilitiesFor } = await import('../../services/agent/capabilities')
      const caps = getEngineCapabilities() ?? defaultCapabilitiesFor(getActiveEngine() ?? 'anthropic')
      res.json({ success: true, data: caps })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // ===== Toolset broker (on-demand MCP toolsets) — mirrors ipc/agent.ts =====
  app.post('/api/agent/toolsets/list', async (req: Request, res: Response) => {
    try {
      const { listToolsets } = await import('../../services/agent')
      res.json({ success: true, data: listToolsets(req.body.spaceId, req.body.conversationId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/agent/toolsets/open', async (req: Request, res: Response) => {
    try {
      const { openToolsetByUser } = await import('../../services/agent')
      const result = await openToolsetByUser(req.body.spaceId, req.body.conversationId, req.body.toolsetId)
      res.json(result.ok ? { success: true } : { success: false, error: result.error })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/agent/toolsets/close', async (req: Request, res: Response) => {
    try {
      const { closeToolsetByUser } = await import('../../services/agent')
      const result = await closeToolsetByUser(req.body.spaceId, req.body.conversationId, req.body.toolsetId)
      res.json(result.ok ? { success: true } : { success: false, error: result.error })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

}
