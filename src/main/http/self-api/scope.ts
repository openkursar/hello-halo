/**
 * Compiles `scope.json` / `routes.json` (built by `scripts/gen-api-ref.mjs`)
 * into matchers the loopback auth middleware uses to tell three things apart:
 * allowed, exists-but-not-exposed, and does-not-exist. The two files share a
 * source, so an endpoint the manual documents as callable is structurally one
 * `scope.json` allows.
 */

import { readApiRefJson } from '../../services/api-ref/resource-path'

interface Endpoint {
  method: string
  path: string
  group?: string
}

interface CompiledEndpoint {
  method: string
  /** The pattern as written, used to correlate a dispatched route with its scope entry. */
  path: string
  matcher: RegExp
  group?: string
}

export interface ScopeResult {
  decision: 'allowed' | 'forbidden' | 'unknown'
  /** Only set for 'forbidden' — absent when the route carries no group (e.g. 'internal'). */
  group?: string
  /** The `:spaceId` path segment, when this route's pattern has one — the space gate's source of truth for path-scoped routes. */
  pathSpaceId?: string
}

function escapeLiteral(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `:spaceId` gets a named capture group so the space gate can read it off the match; every other `:param` stays a plain wildcard. */
function compile(entries: Endpoint[]): CompiledEndpoint[] {
  return entries.map(({ method, path, group }) => {
    const pattern = path
      .split('/')
      .map((segment) => {
        if (segment === ':spaceId') return '(?<spaceId>[^/]+)'
        return segment.startsWith(':') ? '[^/]+' : escapeLiteral(segment)
      })
      .join('/')
    return { method, path, matcher: new RegExp(`^${pattern}$`), group }
  })
}

let scopeEndpoints: CompiledEndpoint[] | null = null
let allEndpoints: CompiledEndpoint[] | null = null
let loadFailureLogged = false

/**
 * Fails closed on a missing or unreadable table — every path classifies as
 * 'unknown' and answers 404 — but does NOT cache that outcome: the tables are
 * generated at build time, and caching a failed read would leave the whole
 * self-API dead for the rest of the process on one transient bad read. Only a
 * successful load is memoized. The one-time log is the signal that would
 * otherwise be missing entirely, since the failure looks to an agent exactly
 * like "this endpoint does not exist".
 */
function load(): { scope: CompiledEndpoint[]; all: CompiledEndpoint[] } {
  if (scopeEndpoints && allEndpoints) return { scope: scopeEndpoints, all: allEndpoints }

  const scope = readApiRefJson<Endpoint[]>('scope.json')
  const all = readApiRefJson<Endpoint[]>('routes.json')
  if (!scope || !all) {
    if (!loadFailureLogged) {
      loadFailureLogged = true
      console.error(
        '[SelfApi] scope.json/routes.json unreadable — every self-API request will 404. ' +
          'Run: node scripts/gen-api-ref.mjs'
      )
    }
    return { scope: [], all: [] }
  }

  scopeEndpoints = compile(scope)
  allEndpoints = compile(all)
  return { scope: scopeEndpoints, all: allEndpoints }
}

/** Force a reload on next `classify()` call — tests only. */
export function resetScopeCache(): void {
  scopeEndpoints = null
  allEndpoints = null
}

/**
 * Classifies a request path already stripped of query string. The caller is
 * responsible for decoding the path and rejecting traversal before calling
 * this — a raw, still-encoded path here would let a percent-encoded segment
 * evade both tables and fall through as "unknown" (404) instead of being
 * correctly matched.
 *
 * Resolves the route Express itself will dispatch to — the FIRST match in
 * registration order, which `routes.json` preserves — and then decides on that
 * one route. Asking instead "does any allowed pattern match this path" is
 * unsound: `GET /api/spaces/halo` is registered before `GET /api/spaces/:spaceId`
 * and is deliberately internal, yet it matches the exposed pattern, so the
 * permissive form authorized a request Express then handed to a route nobody
 * exposed. Any literal route registered ahead of a parameterized sibling has
 * that shape.
 */
export function classify(method: string, decodedPath: string): ScopeResult {
  const { scope, all } = load()

  const dispatched = all.find((e) => e.method === method && e.matcher.test(decodedPath))
  if (!dispatched) return { decision: 'unknown' }

  const pathSpaceId = decodedPath.match(dispatched.matcher)?.groups?.spaceId
  const exposed = scope.some((e) => e.method === dispatched.method && e.path === dispatched.path)

  return exposed
    ? { decision: 'allowed', pathSpaceId }
    : { decision: 'forbidden', group: dispatched.group, pathSpaceId }
}
