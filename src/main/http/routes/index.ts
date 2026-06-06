/**
 * API Routes aggregator — REST endpoints for remote access.
 *
 * The route handlers are split by domain into sibling `*.routes.ts` files;
 * shared imports and path/security helpers live in `_shared.ts`. This file
 * only wires the per-domain registrars onto the Express app, mirroring the
 * IPC API surface.
 */
import type { Express } from 'express'
import { registerConfigRoutes } from './config.routes'
import { registerAiSourcesRoutes } from './ai-sources.routes'
import { registerSpaceRoutes } from './space.routes'
import { registerAgentRoutes } from './agent.routes'
import { registerArtifactRoutes } from './artifact.routes'
import { registerNotifyRoutes } from './notify.routes'
import { registerImRoutes } from './im.routes'
import { registerSystemRoutes } from './system.routes'
import { registerAppsRoutes } from './apps.routes'
import { registerStoreRoutes } from './store.routes'

/**
 * Register all API routes.
 */
export function registerApiRoutes(app: Express): void {
  registerConfigRoutes(app)
  registerAiSourcesRoutes(app)
  registerSpaceRoutes(app)
  registerAgentRoutes(app)
  registerArtifactRoutes(app)
  registerNotifyRoutes(app)
  registerImRoutes(app)
  registerSystemRoutes(app)
  registerAppsRoutes(app)
  registerStoreRoutes(app)

  console.log('[HTTP] API routes registered')
}
