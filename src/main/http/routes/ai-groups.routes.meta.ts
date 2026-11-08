import type { RouteModuleMeta } from './_meta-types'

/**
 * Load-balancing groups. They are set up by the person in Settings, where the
 * accounts and the effect on cost are in view; nothing here is for an agent.
 */
export const MODULE: RouteModuleMeta = {
  file: 'ai-groups',
  routes: {
    'POST /api/ai-groups': { expose: 'internal' },
    'PUT /api/ai-groups/:groupId': { expose: 'internal' },
    'DELETE /api/ai-groups/:groupId': { expose: 'internal' },
    'GET /api/ai-groups/:groupId/health': { expose: 'internal' },
    'POST /api/ai-groups/:groupId/release-rest': { expose: 'internal' },
    'POST /api/ai-groups/routes': { expose: 'internal' },
  },
}
