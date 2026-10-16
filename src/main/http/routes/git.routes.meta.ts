import type { RouteModuleMeta } from './_meta-types'

/**
 * The changes view's plumbing. An agent already runs git itself through its
 * own shell, in the same working tree and with the same configuration, so
 * nothing here would add a capability — only a second, narrower way to do
 * what `git` does.
 */
export const MODULE: RouteModuleMeta = {
  file: 'git',
  routes: {
    'POST /api/git/repositories': { expose: 'internal' },
    'POST /api/git/status': { expose: 'internal' },
    'POST /api/git/changes': { expose: 'internal' },
    'POST /api/git/file-contents': { expose: 'internal' },
    'POST /api/git/revision-options': { expose: 'internal' },
    'POST /api/git/commit-graph': { expose: 'internal' },
    'POST /api/git/stage': { expose: 'internal' },
    'POST /api/git/unstage': { expose: 'internal' },
    'POST /api/git/discard': { expose: 'internal' },
    'POST /api/git/commit': { expose: 'internal' },
    'POST /api/git/sync': { expose: 'internal' },
    'POST /api/git/snapshot': { expose: 'internal' },
    'POST /api/git/count-changed-since': { expose: 'internal' },
  },
}
