/**
 * Auth + scope gate for the self-API loopback listener.
 *
 * Every error envelope here is deliberately over-specified: a weak model
 * reading a terse "not found" tends to retry, ask the user for a token, or
 * conclude Halo can't do the thing at all — the exact failure this whole
 * design exists to prevent. Each message below closes one specific bad
 * reaction; rewording any of them re-opens it.
 *
 * All three carry a `code` field, which is what lets an agent (and the
 * manual's page footer) tell this middleware's 404 apart from a business
 * handler's own 404 ("unknown appId") — the two call for opposite fixes and
 * would otherwise be indistinguishable.
 */

import type { NextFunction, Request, Response } from 'express'
import { API_REF_GROUP_IDS } from '../../services/api-ref/groups'
import { getApiRefPath } from '../../services/api-ref/resource-path'
import { classify } from './scope'
import { resolveSelfApiToken } from './token-store'
import { resolveSelfApiGrant, SELF_API_GRANT_PREFIX } from './grant-store'

const BEARER_PATTERN = /^Bearer\s+(\S.*)$/i

/**
 * Header only — never `?token=`. The public listener accepts a query token
 * because a browser/WebSocket client sometimes has no other way to attach
 * one; an AI session always runs curl and can always set a header. A query
 * token would put the credential into the command text itself, where it ends
 * up in the transcript and the logs.
 */
function extractToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const match = BEARER_PATTERN.exec(header)
  return match ? match[1].trim() : null
}

function grantDeniedBody(code: string, reason?: string) {
  return {
    success: false,
    code: `halo.self_api.${code}`,
    error:
      (reason ? `${reason} ` : '') +
      'This temporary grant is limited to the invited action and expires after 24h or a Halo restart. ' +
      'If it is unavailable or the action is no longer valid, ask the owner to finish in Halo. ' +
      'Do not try other actions, ask for a secret, or enable another capability.',
  }
}

function unauthorizedBody() {
  return {
    success: false,
    code: 'halo.self_api.unauthorized',
    error:
      'Missing or wrong token. $HALO_API_TOKEN is already set in your environment - you most likely dropped the header or ' +
      'quoted it wrong. Retry once with: -H "Authorization: Bearer $HALO_API_TOKEN". Do not ask the user for a token and do ' +
      "not print the variable's value.",
  }
}

/**
 * `group` is the real value read off `routes.json` for this path — never a
 * template placeholder. It is absent only for an 'internal' route, which
 * carries no group in its meta; the redirect sentence is dropped rather than
 * naming a group that isn't real.
 */
function notExposedBody(group: string | undefined) {
  const redirect = group ? ` Other endpoints in this area are open: call halo_api_ref('${group}').` : ''
  return {
    success: false,
    code: 'halo.self_api.not_exposed',
    ...(group ? { group } : {}),
    error:
      'This endpoint exists in Halo but is not opened to the assistant in this build. Do not retry it and do not try a ' +
      'variant of it. Halo itself can still do this from its own interface - tell the user it has to be done in the Halo ' +
      `app, and do NOT tell them Halo cannot do it.${redirect}`,
  }
}

function unknownEndpointBody() {
  const indexPath = getApiRefPath('index.txt') ?? 'resources/api-ref/index.txt'
  return {
    success: false,
    code: 'halo.self_api.unknown_endpoint',
    error:
      "No endpoint is routed at this path in this build. The path itself is wrong - this is not an 'id not found'. Do not " +
      `retry it. You may be recalling a path from a different product. Find the real one: grep -i 'KEYWORD' ${indexPath}` +
      // Spelled out in full rather than as a `<group>` template: an unfilled
      // placeholder is a worse failure than the tokens the eight names cost.
      `   - or call halo_api_ref with one of: ${API_REF_GROUP_IDS.join(', ')}.`,
  }
}

/**
 * Anything outside `/api/` is refused as JSON — no SPA, no static files, no
 * dev proxy.
 *
 * Carries the same `code` as the in-scope 404. Every manual page footer tells
 * the agent that a 404 *with* a code means the path is wrong and one *without*
 * means the id is wrong; a bare envelope here would send an agent that typo'd
 * the prefix off hunting for a correct id it already had.
 */
export function rejectNonApi(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api/')) return next()
  const isGrant = extractToken(req)?.startsWith(SELF_API_GRANT_PREFIX)
  if (isGrant) console.warn('[SelfApi] grant-scope: refused a non-API request')
  res.status(404).json(isGrant
    ? grantDeniedBody('unknown_endpoint')
    : {
      success: false,
      code: 'halo.self_api.unknown_endpoint',
      error: 'Unknown endpoint. This server only serves /api/*. Check the path prefix before retrying.',
    })
}

/**
 * The request path as sent, independent of where this middleware is mounted.
 * `req.path` is relative to the mount point, so under `app.use('/api', ...)`
 * it arrives with `/api` already stripped and matches nothing in a scope
 * table whose entries all begin with `/api/`.
 */
function requestTarget(req: Request): string {
  return req.originalUrl || req.url || `${req.baseUrl ?? ''}${req.path ?? ''}`
}

/**
 * Terminal error handler. Anything that reaches here threw before producing a
 * response, so the reply is built from scratch rather than from the error:
 * a message assembled from `err` risks carrying a file path, a query, or a
 * value the redaction pass would have removed.
 */
export function selfApiErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) return next(err)
  console.error('[SelfApi] Unhandled error:', (err as Error)?.message)
  res.status(500).json({
    success: false,
    code: 'halo.self_api.handler_failed',
    error:
      'The endpoint threw before it answered. Check that the request body is valid JSON and that you sent ' +
      '-H "Content-Type: application/json". Do not retry more than once, and do not report this to the user as ' +
      'a missing capability — the endpoint exists.',
  })
}

export function selfApiAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req)
  const isGrant = token?.startsWith(SELF_API_GRANT_PREFIX) ?? false
  if (isGrant) {
    const result = resolveSelfApiGrant(token!, req.method, requestTarget(req))
    if (result.decision !== 'allowed') {
      const status = result.decision === 'unavailable' ? 401 : 403
      res.status(status).json(grantDeniedBody(
        `grant_${result.decision}`,
        result.decision === 'invalid' ? result.reason : undefined,
      ))
      return
    }
  } else if (!token || !resolveSelfApiToken(token)) {
    res.status(401).json(unauthorizedBody())
    return
  }

  const rawPath = requestTarget(req).split('?')[0]
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    res.status(404).json(isGrant ? grantDeniedBody('unknown_endpoint') : unknownEndpointBody())
    return
  }
  if (decodedPath.includes('..')) {
    res.status(404).json(isGrant ? grantDeniedBody('unknown_endpoint') : unknownEndpointBody())
    return
  }

  // Authorized on both spellings: Express dispatches on the raw path, so
  // allowing on the decoded one alone would let an encoded segment be
  // authorized as one route and then handled as another.
  const rawResult = classify(req.method, rawPath)
  const decodedResult = classify(req.method, decodedPath)
  const result =
    rawResult.decision === 'allowed' && decodedResult.decision === 'allowed'
      ? rawResult
      : rawResult.decision === 'forbidden'
        ? rawResult
        : decodedResult.decision === 'forbidden'
          ? decodedResult
          : { decision: 'unknown' as const, group: undefined }

  if (isGrant && result.decision !== 'allowed') {
    console.warn('[SelfApi] grant-scope: refused an unexposed or unknown action', { method: req.method, path: rawPath })
  }
  if (result.decision === 'forbidden') {
    res.status(403).json(isGrant ? grantDeniedBody('not_exposed') : notExposedBody(result.group))
    return
  }
  if (result.decision === 'unknown') {
    res.status(404).json(isGrant ? grantDeniedBody('unknown_endpoint') : unknownEndpointBody())
    return
  }

  // Regular tokens remain space-independent; grants add only their literal action bound.
  next()
}
