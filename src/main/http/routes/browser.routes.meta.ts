import type { RouteModuleMeta } from './_meta-types'

/**
 * Answering a credential prompt is the user's act, not the assistant's: the
 * whole point is that the value never passes through the model. So these are
 * internal — absent from the manual and denied by the self-API scope.
 */
export const MODULE: RouteModuleMeta = {
  file: 'browser',
  routes: {
    'GET /api/browser/credential-requests': { expose: 'internal' },
    'POST /api/browser/credential-requests/submit': { expose: 'internal' },
    'POST /api/browser/credential-requests/decline': { expose: 'internal' },
  },
}
