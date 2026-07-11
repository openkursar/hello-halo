/**
 * Office-member route allowlist — the HTTP security boundary.
 *
 * This is the single source of truth for which `/api/*` endpoints an
 * office-member credential may reach. It is DEFAULT DENY: only the team
 * read-only family below is permitted. Any control-plane endpoint
 * (`/api/agent/*`, team run/pause/members/edges, file/shell, PIN-only routes,
 * space/config/system, etc.) falls through to `false` and the middleware
 * answers 403.
 *
 * Paths are matched against the FULL request path including the `/api` prefix
 * (e.g. `/api/teams/abc123/epochs`). `:param` segments match a single path
 * segment (no '/').
 */

interface ScopeRoute {
  method: 'GET' | 'POST'
  regex: RegExp
}

/** Convert a `:param` route pattern into an anchored, segment-safe regex. */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[^/]+/g, '[^/]+')
  return new RegExp(`^${escaped}$`)
}

/**
 * The office-member allowlist: the team READ-ONLY family plus the single
 * member-dispatch endpoint (send-to-member). The POST is admitted here only so
 * the credential reaches the route; the route itself then enforces who may
 * dispatch to whom (canContact + canCoordinationWrite). Exported so downstream
 * slices and tests can introspect the security boundary.
 */
export const OFFICE_READ_ROUTES: ScopeRoute[] = [
  { method: 'GET', regex: patternToRegex('/api/teams/:teamId') },
  { method: 'GET', regex: patternToRegex('/api/teams/:teamId/detail') },
  { method: 'GET', regex: patternToRegex('/api/teams/:teamId/chat-messages') },
  { method: 'GET', regex: patternToRegex('/api/teams/:teamId/artifacts') },
  { method: 'GET', regex: patternToRegex('/api/teams/:teamId/epochs') },
  { method: 'GET', regex: patternToRegex('/api/teams/:teamId/epochs/:epochId/board') },
  { method: 'GET', regex: patternToRegex('/api/teams/:teamId/epochs/:epochId/artifacts') },
  { method: 'POST', regex: patternToRegex('/api/teams/:teamId/members/:appId/send') },
]

/**
 * Whether an office-member credential may reach (method, path). Returns true
 * ONLY for the team read-only family above; everything else is denied.
 */
export function matchOfficeScope(method: string, path: string): boolean {
  const upper = method.toUpperCase()
  for (const route of OFFICE_READ_ROUTES) {
    if (route.method === upper && route.regex.test(path)) {
      return true
    }
  }
  return false
}
