/**
 * AiSources REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  getAISourceManager,
  modelCapabilitiesService,
} from './_shared'
import { isCatalogModelCapability } from '../../../shared/model-catalog'
import { validateModelCapabilityOverrides } from '../../../shared/model-capability-overrides'

export function registerAiSourcesRoutes(app: Express): void {
  // ===== AI Sources CRUD Routes (atomic operations) =====
  // These routes read from disk before writing, ensuring rotating tokens are never overwritten.

  app.post('/api/ai-sources/switch-source', async (req: Request, res: Response) => {
    try {
      const { sourceId } = req.body
      const manager = getAISourceManager()
      const result = manager.switchCurrentSource(sourceId)
      if (result.currentId !== sourceId) {
        res.json({ success: false, error: `Source not found: ${sourceId}` })
        return
      }
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/ai-sources/set-model', async (req: Request, res: Response) => {
    try {
      const { modelId } = req.body
      const manager = getAISourceManager()
      const result = manager.switchCurrentModel(modelId)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/ai-sources/sources', async (req: Request, res: Response) => {
    try {
      const manager = getAISourceManager()
      const result = manager.addSource(req.body)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.put('/api/ai-sources/sources/:sourceId', async (req: Request, res: Response) => {
    try {
      const manager = getAISourceManager()
      const result = manager.updateSource(req.params.sourceId, req.body)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.delete('/api/ai-sources/sources/:sourceId', async (req: Request, res: Response) => {
    try {
      const manager = getAISourceManager()
      const result = manager.deleteSource(req.params.sourceId)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })


  // ===== Model Capabilities Routes =====

  // POST /api/model-capabilities/resolve — resolve final capability (preset + user overrides)
  app.post('/api/model-capabilities/resolve', (req: Request, res: Response) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        res.status(400).json({ success: false, error: 'Invalid request body' })
        return
      }
      const { modelId, overrides, catalogCapability, catalogSupportsVision } = req.body as Record<string, unknown>
      if (typeof modelId !== 'string' || !modelId.trim() || modelId !== modelId.trim() || modelId.length > 512) {
        res.status(400).json({ success: false, error: 'Missing required field: modelId' })
        return
      }
      if (overrides !== undefined && !validateModelCapabilityOverrides(overrides)) {
        res.status(400).json({ success: false, error: 'Invalid model capability overrides' })
        return
      }
      if (catalogCapability !== undefined && !isCatalogModelCapability(catalogCapability)) {
        res.status(400).json({ success: false, error: 'Invalid catalog capability' })
        return
      }
      if (catalogSupportsVision !== undefined && typeof catalogSupportsVision !== 'boolean') {
        res.status(400).json({ success: false, error: 'Invalid catalog vision flag' })
        return
      }
      res.json({
        success: true,
        data: modelCapabilitiesService.resolve(
          modelId.trim(),
          overrides,
          catalogCapability,
          catalogSupportsVision
        )
      })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/model-capabilities/preset/:modelId — get raw preset for a model
  app.get('/api/model-capabilities/preset/:modelId', (req: Request, res: Response) => {
    try {
      const modelId = decodeURIComponent(req.params.modelId)
      res.json({
        success: true,
        data: modelCapabilitiesService.getPreset(modelId)
      })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/model-capabilities/all — get all presets
  app.get('/api/model-capabilities/all', (_req: Request, res: Response) => {
    try {
      res.json({
        success: true,
        data: modelCapabilitiesService.getAllPresets()
      })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

}
