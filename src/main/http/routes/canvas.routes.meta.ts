import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'canvas',
  routes: {
    // A client's answer to the AI's own canvas_show request; meaningless to anyone else.
    'POST /api/canvas/show-reply': { expose: 'internal' },
  },
}
