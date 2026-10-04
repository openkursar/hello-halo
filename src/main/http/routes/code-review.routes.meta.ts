import type { RouteModuleMeta } from './_meta-types'

/**
 * The changes view's review buttons. Starting one creates a conversation in
 * the background and spends tokens on a fixed review prompt; an agent asked
 * to review changes does it in its own conversation instead, and the other
 * two routes only describe what those buttons should show.
 */
export const MODULE: RouteModuleMeta = {
  file: 'code-review',
  routes: {
    'POST /api/code-review/start': { expose: 'internal' },
    'GET /api/code-review/latest': { expose: 'internal' },
    'GET /api/code-review/availability': { expose: 'internal' },
  },
}
