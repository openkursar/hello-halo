import type { RouteModuleMeta } from './_meta-types'

// Renderer plumbing for the local tool manager. Trust decisions (import,
// register, re-confirm) are the user's, so none of it is exposed to the AI.
export const MODULE: RouteModuleMeta = {
  file: 'cli-tools',
  routes: {
    'POST /api/cli-tools/overview': { expose: 'internal' },
    'POST /api/cli-tools/set-current': { expose: 'internal' },
    'POST /api/cli-tools/set-disabled': { expose: 'internal' },
    'POST /api/cli-tools/remove-version': { expose: 'internal' },
    'POST /api/cli-tools/remove-tool': { expose: 'internal' },
    'POST /api/cli-tools/reconfirm-external': { expose: 'internal' },
    'POST /api/cli-tools/pick-package': { expose: 'internal' },
    'POST /api/cli-tools/confirm-import': { expose: 'internal' },
    'POST /api/cli-tools/cancel-import': { expose: 'internal' },
    'POST /api/cli-tools/pick-external': { expose: 'internal' },
    'POST /api/cli-tools/register-external': { expose: 'internal' },
  },
}
