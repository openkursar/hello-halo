/**
 * How an automation event is shown to the model.
 *
 * The run record keeps the event as it arrived; the model gets it without the
 * caller's request metadata. A webhook payload carries every request header
 * (Authorization, Cookie, signatures) and the caller's address — none of it is
 * the event's content, and all of it would otherwise reach the model provider
 * and the run's visible transcript. The body, path and query stay: a
 * webhook-driven automation acts on them.
 */

import type { TriggerContext } from './types'

const HIDDEN_FROM_MODEL = new Set(['headers', 'ip'])

export function eventPayloadForModel(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !HIDDEN_FROM_MODEL.has(key)))
}

/** An event delivered as an addition to a run, or as one of several merged into a run. */
export function renderEventInput(trigger: TriggerContext): string {
  return `[New automation event]\n${trigger.description}\n\n${JSON.stringify(eventPayloadForModel(trigger.eventPayload ?? {}), null, 2)}`
}

/** The trigger line of a run's opening message. */
export function renderTriggerContext(trigger: TriggerContext): string {
  return trigger.type === 'event' && trigger.eventPayload
    ? `${trigger.description}\n\nEvent data:\n${JSON.stringify(eventPayloadForModel(trigger.eventPayload), null, 2)}`
    : trigger.description
}
