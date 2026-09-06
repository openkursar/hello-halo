import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'system',
  routes: {
    // Reads product.json, which on an enterprise build carries internal
    // endpoints and provider presets. Never widened to the assistant.
    'GET /api/auth/providers': { expose: 'internal' },

    'GET /api/system/version': {
      expose: 'ai',
      group: 'settings',
      summary: 'Read the running Halo version',
      returns: '{"success":true,"data":"2.1.15"}',
    },

    'POST /api/analytics/report': { expose: 'internal' },
  },
}
