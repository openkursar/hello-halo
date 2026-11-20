import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'ai-browser',
  routes: {
    // Renderer plumbing for the canvas tabs of other conversations' pages; an agent uses its own browser tools.
    'GET /api/ai-browser/live-pages': { expose: 'internal' },
  },
}
