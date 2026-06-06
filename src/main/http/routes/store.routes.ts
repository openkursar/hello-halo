/**
 * Store REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  MCP_COMMAND_BLOCKED,
  rejectIfRemoteMcpForbiddenAsync,
  storeController,
  storeSlugIsMcp,
} from './_shared'

export function registerStoreRoutes(app: Express): void {
  // ===== Store (App Registry) Routes =====

  // POST /api/store/query — paginated query (new primary entry point)
  app.post('/api/store/query', async (req: Request, res: Response) => {
    try {
      const { search, type, category, page, pageSize, locale } = req.body as Record<string, unknown>
      const result = await storeController.queryStoreApps({
        search: typeof search === 'string' ? search : undefined,
        type: typeof type === 'string' ? type : undefined,
        category: typeof category === 'string' ? category : undefined,
        page: typeof page === 'number' ? page : undefined,
        pageSize: typeof pageSize === 'number' ? pageSize : undefined,
        locale: typeof locale === 'string' ? locale : undefined,
      })
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/store/apps — list apps from the store (legacy compat)
  app.get('/api/store/apps', async (req: Request, res: Response) => {
    try {
      const query: { search?: string; locale?: string; category?: string; type?: string; tags?: string[] } = {}
      if (typeof req.query.search === 'string') query.search = req.query.search
      if (typeof req.query.locale === 'string') query.locale = req.query.locale
      if (typeof req.query.category === 'string') query.category = req.query.category
      if (typeof req.query.type === 'string') query.type = req.query.type
      if (typeof req.query.tags === 'string') {
        query.tags = req.query.tags.split(',').map(tag => tag.trim()).filter(Boolean)
      } else if (Array.isArray(req.query.tags)) {
        query.tags = req.query.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map(tag => tag.trim())
          .filter(Boolean)
      }
      const result = await storeController.listStoreApps(query)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/store/apps/:slug — get store app detail
  app.get('/api/store/apps/:slug', async (req: Request, res: Response) => {
    try {
      const result = await storeController.getStoreAppDetail(req.params.slug)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/install — install an app from the store
  app.post('/api/store/install', async (req: Request, res: Response) => {
    try {
      const { slug, spaceId, userConfig } = req.body as {
        slug?: string
        spaceId?: string | null
        userConfig?: Record<string, unknown>
      }
      if (!slug || typeof slug !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: slug' })
        return
      }
      if (
        await rejectIfRemoteMcpForbiddenAsync(
          res,
          () => storeSlugIsMcp(slug),
          'POST /api/store/install',
        )
      ) return
      // spaceId may be null for global installs (MCP/Skill available across all spaces)
      const resolvedSpaceId = spaceId || null
      const result = await storeController.installStoreApp(slug, resolvedSpaceId, userConfig)
      if (!result.success && result.code === 'MCP_COMMAND_BLOCKED') {
        res.status(403).json(result)
        return
      }
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/apps/:slug/install — REST-style install route
  app.post('/api/store/apps/:slug/install', async (req: Request, res: Response) => {
    try {
      const slug = req.params.slug
      const { spaceId, userConfig } = req.body as {
        spaceId?: string | null
        userConfig?: Record<string, unknown>
      }
      if (!slug || typeof slug !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required param: slug' })
        return
      }
      if (
        await rejectIfRemoteMcpForbiddenAsync(
          res,
          () => storeSlugIsMcp(slug),
          'POST /api/store/apps/:slug/install',
        )
      ) return
      // spaceId may be null for global installs (MCP/Skill available across all spaces)
      const resolvedSpaceId = spaceId || null
      const result = await storeController.installStoreApp(slug, resolvedSpaceId, userConfig)
      if (!result.success && result.code === 'MCP_COMMAND_BLOCKED') {
        res.status(403).json(result)
        return
      }
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/refresh — refresh the registry index
  app.post('/api/store/refresh', async (req: Request, res: Response) => {
    try {
      const result = await storeController.refreshStoreIndex()
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/store/updates — check for available updates
  app.get('/api/store/updates', async (req: Request, res: Response) => {
    try {
      const result = await storeController.checkStoreUpdates()
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/store/registries — get configured registry sources
  app.get('/api/store/registries', async (req: Request, res: Response) => {
    try {
      const result = storeController.getStoreRegistries()
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/registries — add a new registry source
  app.post('/api/store/registries', async (req: Request, res: Response) => {
    try {
      const result = storeController.addStoreRegistry(req.body)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // DELETE /api/store/registries/:registryId — remove a registry source
  app.delete('/api/store/registries/:registryId', async (req: Request, res: Response) => {
    try {
      const result = storeController.removeStoreRegistry(req.params.registryId)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/registries/:registryId/toggle — enable or disable a registry source
  app.post('/api/store/registries/:registryId/toggle', async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body as { enabled?: boolean }
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'Missing required field: enabled' })
        return
      }
      const result = storeController.toggleStoreRegistry(req.params.registryId, enabled)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // PATCH /api/store/registries/:registryId/adapter-config — update adapter config (e.g. API keys)
  app.patch('/api/store/registries/:registryId/adapter-config', async (req: Request, res: Response) => {
    try {
      const adapterConfig = req.body as Record<string, unknown>
      if (!adapterConfig || typeof adapterConfig !== 'object' || Array.isArray(adapterConfig)) {
        res.status(400).json({ success: false, error: 'Request body must be a JSON object' })
        return
      }
      const result = storeController.updateStoreRegistryAdapterConfig(req.params.registryId, adapterConfig)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

}
