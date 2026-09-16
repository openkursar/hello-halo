import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'system',
  routes: {
    'GET /api/auth/providers': {
      expose: 'ai',
      group: 'settings',
      summary: 'List the sign-in and model providers this build offers',
      returns: '{"success":true,"data":[{"type":"…","displayName":"…","enabled":true,"recommended":false,"platforms":["darwin"]}]}',
      notes: 'What this build could be configured with, not what the user has configured — read GET /api/config for that. On an enterprise build the preset field carries deployment-internal endpoints; do not repeat them back.',
    },

    'GET /api/system/version': {
      expose: 'ai',
      group: 'settings',
      summary: 'Read the running Halo version',
      returns: '{"success":true,"data":"2.1.15"}',
    },

    // Product telemetry ingestion. An agent-generated event is indistinguishable
    // from a real one downstream, so this stays a renderer-only door.
    'POST /api/analytics/report': { expose: 'internal' },
  },
}
