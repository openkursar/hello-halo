/**
 * Body fields — or single values of a field — an exposed route accepts from
 * Halo's own clients but not from an assistant session.
 *
 * The manual documents a route by the fields an agent may send. A field left
 * out of it on purpose must be refused, not quietly honored: otherwise the
 * listener grants more than the manual admits to, and the scope table stops
 * being the whole bound.
 */

import type { NextFunction, Request, Response } from 'express'

interface WithheldField {
  field: string
  /**
   * The one value of `field` that is refused, when the field itself is open;
   * the refusal names it so the agent does not drop the field altogether.
   */
  value?: string
  /** Why it is refused, and what the agent should do instead. */
  guidance: string
  /** For a field nested below the top level, or a single value; `field` then names it as the agent would write it. */
  isPresent?: (body: Record<string, unknown>) => boolean
}

const DELEGATED_POLICY_GUIDANCE =
  "It sets what teammates on other computers may make this member do, which the owner decides from the member's " +
  'settings in the Halo app. Resend without the field; tell the user where to set it if they asked for it.'

const WEBHOOK_TRIGGER_GUIDANCE =
  "A webhook trigger lets anyone who can reach this computer start the team with the owner's permissions, so the " +
  'assistant may not add or change one. Do not retry it in another form. Tell the user this is something you cannot ' +
  'set up for them, and offer a schedule or file trigger if one fits.'

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
  'POST /api/teams': [
    {
      field: 'input.members[].delegatedPolicy',
      guidance: DELEGATED_POLICY_GUIDANCE,
      isPresent: (body) => {
        const members = (body.input as { members?: unknown } | undefined)?.members
        return Array.isArray(members) && members.some(
          (member) => typeof member === 'object' && member !== null && 'delegatedPolicy' in member
        )
      },
    },
  ],
  'POST /api/teams/:teamId/members': [{ field: 'delegatedPolicy', guidance: DELEGATED_POLICY_GUIDANCE }],
  'PATCH /api/teams/:teamId/members/:appId': [{ field: 'delegatedPolicy', guidance: DELEGATED_POLICY_GUIDANCE }],
  // Adds and changes alike: a change must name the trigger's own type (team service `setTrigger`).
  'POST /api/teams/:teamId/triggers': [
    {
      field: 'trigger.sourceType',
      value: 'webhook',
      guidance: WEBHOOK_TRIGGER_GUIDANCE,
      isPresent: (body) => (body.trigger as { sourceType?: unknown } | undefined)?.sourceType === 'webhook',
    },
  ],
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
    ? withheld.find(({ field, isPresent }) => (isPresent ? isPresent(body) : body[field] !== undefined))
    : undefined
  if (!hit) return next()

  const refused = hit.value === undefined ? `The field "${hit.field}"` : `The value "${hit.value}" for "${hit.field}"`
  console.warn(`[SelfApi] Refused ${req.method} ${requestPath(req)}: ${refused} is not open to the assistant`)
  res.status(400).json({
    success: false,
    code: 'halo.self_api.field_not_accepted',
    field: hit.field,
    ...(hit.value === undefined ? {} : { value: hit.value }),
    error: `${refused} is not accepted on this endpoint for the assistant. ${hit.guidance}`,
  })
}
