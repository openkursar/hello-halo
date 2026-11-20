import type { RouteModuleMeta } from './_meta-types'

// Renderer plumbing for the company sign-in dialog. Signing in is the user's
// act on their phone, so none of it is exposed to the AI.
export const MODULE: RouteModuleMeta = {
  file: 'enterprise-identity',
  routes: {
    'POST /api/enterprise-identity/state': { expose: 'internal' },
    'POST /api/enterprise-identity/begin': { expose: 'internal' },
    'POST /api/enterprise-identity/poll': { expose: 'internal' },
    'POST /api/enterprise-identity/cancel': { expose: 'internal' },
    'POST /api/enterprise-identity/sign-out': { expose: 'internal' },
  },
}
