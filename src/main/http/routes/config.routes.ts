/**
 * Config REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  configController,
  configTouchesMcp,
  getAISourceManager,
  getPublicSecurityPolicy,
  getServiceConfig,
  rejectIfRemoteMcpForbidden,
} from './_shared'

export function registerConfigRoutes(app: Express): void {
  // ===== Security Policy =====
  // Renderer-safe slice of the security policy. Returned to both the
  // Electron renderer (via the IPC mirror) and to remote/web clients so
  // every UI surface gates consistently.
  app.get('/api/security/policy', async (_req: Request, res: Response) => {
    res.json({ success: true, data: getPublicSecurityPolicy() })
  })


  // ===== Config Routes =====
  app.get('/api/config', async (req: Request, res: Response) => {
    const result = configController.getConfig()
    res.json(result)
  })

  app.post('/api/config', async (req: Request, res: Response) => {
    if (rejectIfRemoteMcpForbidden(res, () => configTouchesMcp(req.body), 'POST /api/config')) return
    const result = configController.setConfig(req.body)
    res.json(result)
  })

  app.post('/api/config/validate', async (req: Request, res: Response) => {
    const { apiKey, apiUrl, provider, model } = req.body
    const result = await configController.validateApi(apiKey, apiUrl, provider, model)
    res.json(result)
  })

  app.post('/api/config/fetch-models', async (req: Request, res: Response) => {
    const { apiKey, apiUrl } = req.body
    const result = await configController.fetchModels(apiKey, apiUrl)
    res.json(result)
  })

  app.post('/api/config/refresh-ai-sources', async (_req: Request, res: Response) => {
    try {
      const manager = getAISourceManager()
      await manager.refreshAllConfigs()
      const config = getServiceConfig()
      res.json({ success: true, data: config })
    } catch (error) {
      console.error('[HTTP] refresh-ai-sources failed:', (error as Error).message)
      res.json({ success: false, error: (error as Error).message })
    }
  })

}
