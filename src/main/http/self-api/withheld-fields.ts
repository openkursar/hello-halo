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
  ],
}

function routeKey(req: Request): string {
  const path = (req.originalUrl || req.url || '').split('?')[0]
  return `${req.method} ${path}`
}

export function rejectWithheldFields(req: Request, res: Response, next: NextFunction): void {
  const withheld = WITHHELD_FIELDS[routeKey(req)]
  const body = req.body as Record<string, unknown> | undefined
  const hit = withheld && body && typeof body === 'object'
    ? withheld.find(({ field }) => body[field] !== undefined)
    : undefined
  if (!hit) return next()

  console.warn(`[SelfApi] Refused ${routeKey(req)}: body field "${hit.field}" is not open to the assistant`)
  res.status(400).json({
    success: false,
    code: 'halo.self_api.field_not_accepted',
    field: hit.field,
    error: `The field "${hit.field}" is not accepted on this endpoint for the assistant. ${hit.guidance}`,
  })
}
