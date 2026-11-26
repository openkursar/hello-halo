import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'enterprise-identity',
  routes: {
    'POST /api/enterprise-identity/state': { expose: 'internal' },
    'POST /api/enterprise-identity/sign-in': { expose: 'internal' },
    'POST /api/enterprise-identity/retry': { expose: 'internal' },
    'POST /api/enterprise-identity/sign-out': { expose: 'internal' },
  },
}
