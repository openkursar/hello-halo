/**
 * Body fields an exposed route accepts from Halo's own clients but not from an
 * assistant session.
 *
 * The manual documents a route by the fields an agent may send. A field left
 * out of it on purpose must be refused, not quietly honored: otherwise the
 * listener grants more than the manual admits to, and the scope table stops
 * being the whole bound.
 */

import type { NextFunction, Request, Response } from 'express'

interface WithheldField {
  field: string
  /** Why it is refused, and what the agent should do instead. */
  guidance: string
}

/**
 * What the user has on screen and the places they pointed at. The model reads
 * both as the user's own context, so an assistant sending them would speak for
 * the user.
 */
const USER_POINTING_FIELDS: readonly WithheldField[] = [
  {
    field: 'canvasContext',
    guidance: "It describes what the user has open in Halo. Mention what you need in the message text instead, and resend without the field.",
  },
  {
    field: 'references',
    guidance: 'References record places the user pointed at. Name files and lines in the message text instead, and resend without the field.',
  },
]

/** Keyed by the route's manual entry (`<METHOD> <path>` in routes/*.routes.meta.ts). */
export const WITHHELD_FIELDS: Readonly<Record<string, readonly WithheldField[]>> = {
  'POST /api/agent/message': [
    {
      field: 'goal',
      // Setting it here would record the change as the user's own.
      guidance:
        "A conversation's goal is set by the user from the Halo app. To track a goal for your own work, use your Goal " +
        'tool. Resend the request without the field.',
    },
    ...USER_POINTING_FIELDS,
  ],
  'POST /api/apps/:appId/chat/send': USER_POINTING_FIELDS,
  'POST /api/apps/:appId/runs/:runId/inject': USER_POINTING_FIELDS.filter(({ field }) => field === 'references'),
}

function requestPath(req: Request): string {
  return (req.originalUrl || req.url || '').split('?')[0]
}

/**
 * Matched the way Express dispatches — any letter case, one optional trailing
 * slash — so a request that reaches the handler is checked whatever spelling
 * the scope gate let through.
 */
const MATCHERS = Object.entries(WITHHELD_FIELDS).map(([route, fields]) => {
  const [method, path] = route.split(' ')
  const pattern = path.split('/').map(segment =>
    segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('/')
  return { method, pattern: new RegExp(`^${pattern}/?$`, 'i'), fields }
})

function withheldFor(req: Request): readonly WithheldField[] | undefined {
  const path = requestPath(req)
  return MATCHERS.find(entry => entry.method === req.method && entry.pattern.test(path))?.fields
}

export function rejectWithheldFields(req: Request, res: Response, next: NextFunction): void {
  const withheld = withheldFor(req)
  const body = req.body as Record<string, unknown> | undefined
  const hit = withheld && body && typeof body === 'object'
    ? withheld.find(({ field }) => body[field] !== undefined)
    : undefined
  if (!hit) return next()

  console.warn(`[SelfApi] Refused ${req.method} ${requestPath(req)}: body field "${hit.field}" is not open to the assistant`)
  res.status(400).json({
    success: false,
    code: 'halo.self_api.field_not_accepted',
    field: hit.field,
    error: `The field "${hit.field}" is not accepted on this endpoint for the assistant. ${hit.guidance}`,
  })
}
