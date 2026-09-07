import type { RouteModuleMeta } from './_meta-types'

/**
 * The team surface is renderer- and federation-facing only: none of it is
 * offered to the assistant, so no group page exists for it. Two different
 * reasons are folded into the same label here.
 *
 * The control-plane routes (invite, join, leave, federation/presence) are
 * internal by design and stay that way — invite mints a credential, join and
 * leave move this node in and out of someone else's office, and the middleware
 * already refuses them to an office credential. Handing any of them to the
 * assistant would let it widen its own reach.
 *
 * The rest are internal for now rather than forever: they are a real capability
 * an agent could use, but the shapes they return are still moving, and a manual
 * page pinned to them would document an interface that no longer exists.
 * Exposing them is a separate decision that needs a group of its own.
 */
export const MODULE: RouteModuleMeta = {
  file: 'team',
  routes: {
    'GET /api/teams': { expose: 'internal' },
    'POST /api/teams': { expose: 'internal' },
    'POST /api/teams/propose-members': { expose: 'internal' },
    'GET /api/teams/:teamId': { expose: 'internal' },
    'GET /api/teams/:teamId/detail': { expose: 'internal' },
    'GET /api/teams/:teamId/chat-messages': { expose: 'internal' },
    'POST /api/teams/:teamId/members/:appId/send': { expose: 'internal' },
    'GET /api/teams/:teamId/artifacts': { expose: 'internal' },
    'GET /api/teams/:teamId/conversations': { expose: 'internal' },
    'POST /api/teams/:teamId/conversations': { expose: 'internal' },
    'PATCH /api/teams/:teamId/conversations/:epochId': { expose: 'internal' },
    'DELETE /api/teams/:teamId/conversations/:epochId': { expose: 'internal' },
    'GET /api/teams/:teamId/epochs': { expose: 'internal' },
    'GET /api/teams/:teamId/epochs/:epochId/board': { expose: 'internal' },
    'GET /api/teams/:teamId/epochs/:epochId/artifacts': { expose: 'internal' },
    'PATCH /api/teams/:teamId': { expose: 'internal' },
    'DELETE /api/teams/:teamId': { expose: 'internal' },
    'POST /api/teams/:teamId/members': { expose: 'internal' },
    'PATCH /api/teams/:teamId/members/:appId': { expose: 'internal' },
    'DELETE /api/teams/:teamId/checks/:checkId': { expose: 'internal' },
    'DELETE /api/teams/:teamId/members/:appId': { expose: 'internal' },
    'PUT /api/teams/:teamId/edges': { expose: 'internal' },
    'POST /api/teams/:teamId/run': { expose: 'internal' },
    'POST /api/teams/:teamId/pause': { expose: 'internal' },
    'GET /api/teams/:teamId/triggers': { expose: 'internal' },
    'POST /api/teams/:teamId/triggers': { expose: 'internal' },
    'POST /api/teams/:teamId/invite': { expose: 'internal' },
    'DELETE /api/teams/:teamId/invite/:jti': { expose: 'internal' },
    'POST /api/teams/:teamId/join': { expose: 'internal' },
    'POST /api/teams/:teamId/leave': { expose: 'internal' },
    'GET /api/teams/:teamId/federation/presence': { expose: 'internal' },
    'DELETE /api/teams/:teamId/triggers/:triggerId': { expose: 'internal' },
  },
}
