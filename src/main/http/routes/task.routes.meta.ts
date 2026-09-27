import type { RouteModuleMeta } from './_meta-types'

/**
 * Bookkeeping for the task panel: which finished conversations a client has
 * looked at, and which it has been told to keep. It records what one client
 * has seen, so there is nothing here an agent could answer a question with.
 */
export const MODULE: RouteModuleMeta = {
  file: 'task',
  routes: {
    'GET /api/task-state': { expose: 'internal' },
    'POST /api/task-state/mark-unseen': { expose: 'internal' },
    'POST /api/task-state/mark-read': { expose: 'internal' },
    'POST /api/task-state/set-kept': { expose: 'internal' },
    'POST /api/task-state/remove': { expose: 'internal' },
  },
}
