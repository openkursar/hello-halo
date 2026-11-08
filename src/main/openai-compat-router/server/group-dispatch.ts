/**
 * Serving one model request from a load-balancing group.
 *
 * The group's members are tried in the order the balancer gives, each with a
 * complete handler run behind a `HeldResponse`: a member that fails before its
 * reply carries anything the engine would act on hands the request to the next
 * one, and the engine never sees the failure. A reply that has begun is the
 * engine's from then on — it is never replayed, so no tool call can run twice.
 *
 * The attempt budget is shared with the engine's own retries by what this
 * module tells the engine at the end: after real failover, the final error
 * forbids another retry, so one request costs at most the budget in total.
 */

import { createHash } from 'node:crypto'
import type { Response as ExpressResponse } from 'express'
import type { Attempt, FailureEvidence, GroupShape, RunSummary } from '../balancing'
import { answersLocally } from '../interceptors'
import type { AnthropicRequest, BackendConfig } from '../types'
import { extractFirstUserMessageText, pickSessionId } from '../utils'
import { sendError } from './error-response'
import { emitGroupRouteFact, type GroupRouteMember } from './group-facts'
import { getGroupBalancer } from './group-balancer'
import { failureReason, lastFailureAsError, toFailureEvidence, type FinalError } from './group-evidence'
import { HeldResponse } from './held-response'
import { handleMessagesRequest, type RequestHandlerOptions } from './request-handler'
import type { GroupMemberPlan, GroupPlan } from './request-groups'

/** How long a member that has an alternative behind it may take to answer with headers. */
export const ATTEMPT_HEADERS_TIMEOUT_MS = 90_000
/** How long a streamed reply that has begun may stay without content before the next member is tried. */
export const ATTEMPT_FIRST_CONTENT_TIMEOUT_MS = 180_000

function toGroupShape(plan: GroupPlan): GroupShape {
  return { id: plan.id, strategy: plan.strategy, members: plan.members.map(entry => entry.member) }
}

/**
 * Which conversation a request belongs to. Engines name it in a header; when
 * one does not, the opening user message stands in, which is the same for every
 * request of a conversation.
 */
export function sessionKeyFor(request: AnthropicRequest, sdkHeaders?: Record<string, string>): string | null {
  const named = pickSessionId(sdkHeaders)
  if (named) return named
  const opening = extractFirstUserMessageText(request.messages ?? [])
  if (!opening) return null
  return `opening:${createHash('sha1').update(opening).digest('hex').slice(0, 16)}`
}

function describeMember(entry: GroupMemberPlan): GroupRouteMember {
  return { ...entry.member, label: entry.label }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface FailedAttempt {
  entry: GroupMemberPlan
  evidence: FailureEvidence
  error: FinalError
}

function describeExhaustion(plan: GroupPlan, summary: RunSummary, failed: FailedAttempt[], now: number): FinalError {
  const last = failed.at(-1)
  if (!last) {
    const minutes = summary.retryAt ? Math.max(1, Math.ceil((summary.retryAt - now) / 60_000)) : null
    return {
      type: 'overloaded_error',
      message: `None of the models in "${plan.name}" can be used right now after recent failures`
        + (minutes ? `; the first may be back in about ${minutes} minute${minutes === 1 ? '' : 's'}.` : '.'),
    }
  }
  const tried = failed.map(item => `${item.entry.label.account} / ${item.entry.label.model} ${failureReason(item.evidence)}`)
  const prefix = failed.length > 1
    ? `All ${failed.length} models tried in "${plan.name}" failed (${tried.join('; ')}). Last error: `
    : ''
  return { ...last.error, message: `${prefix}${last.error.message}` }
}

function restNote(verdict: { rest: { reason: string; until: number } | null }): string {
  return verdict.rest ? `${verdict.rest.reason}:${Math.max(0, Math.round((verdict.rest.until - Date.now()) / 1000))}s` : 'none'
}

export async function handleGroupMessagesRequest(
  request: AnthropicRequest,
  sessionConfig: BackendConfig,
  plan: GroupPlan,
  res: ExpressResponse,
  options: RequestHandlerOptions
): Promise<void> {
  // The router answers some requests itself; none of them should pick a member.
  if (answersLocally(request, { originalModel: request.model, res })) {
    return handleMessagesRequest(request, sessionConfig, res, options)
  }

  const sessionKey = sessionKeyFor(request, options.sdkHeaders)
  const run = getGroupBalancer().start(toGroupShape(plan), sessionKey)
  const streaming = request.stream === true
  const entries = new Map(plan.members.map(entry => [entry.member.key, entry]))

  let held: HeldResponse | null = null
  let clientGone = false
  const onClientClose = () => {
    clientGone = true
    held?.abandon()
  }
  res.once('close', onClientClose)

  const failed: FailedAttempt[] = []
  let lastStatus: number | undefined
  let previous: { member: GroupRouteMember; reason: string } | undefined
  let served: Promise<void> | null = null
  // The attempt whose outcome the balancer has not heard yet; released if anything throws.
  let open: Attempt | null = null

  try {
    while (!clientGone) {
      const attempt = run.next()
      if (!attempt) break
      open = attempt
      const entry = entries.get(attempt.member.key)
      const subject = `group=${plan.id} attempt=${attempt.index} source=${attempt.member.sourceId} model=${attempt.member.modelId}`
      if (!entry) {
        console.warn(`[Router] group_attempt_skipped ${subject}: the balancer offered a model the plan does not hold`)
        run.abandoned(attempt)
        open = null
        continue
      }
      const member = describeMember(entry)
      // The ordinary first attempt is silent: the handler reports every request itself.
      if (attempt.probe) console.log(`[Router] group_probe ${subject}: trying a resting model again`)
      emitGroupRouteFact({ groupId: plan.id, sessionKey, phase: 'trying', member, attempt: attempt.index, previous, at: Date.now() })

      let memberConfig: BackendConfig
      try {
        memberConfig = await plan.materialize(attempt.member)
      } catch (error) {
        const evidence: FailureEvidence = { kind: 'credential', message: errorMessage(error) }
        run.failed(attempt, evidence)
        open = null
        console.warn(`[Router] group_attempt_failed ${subject} kind=credential reason="${evidence.message.slice(0, 160).replace(/\s+/g, ' ')}"`)
        lastStatus = undefined
        failed.push({ entry, evidence, error: lastFailureAsError({ cause: 'credential', message: evidence.message }) })
        previous = { member, reason: failureReason(evidence) }
        continue
      }
      if (clientGone) {
        console.log(`[Router] group_client_gone ${subject}: the caller left before the model was asked`)
        run.abandoned(attempt)
        open = null
        break
      }

      // A member with an alternative behind it must not hold the request for long;
      // the last chance, and any non-streamed call, gets the full patience.
      const patient = !streaming || !run.hasNext()
      const attemptHeld = new HeldResponse(res, patient ? {} : { firstContentTimeoutMs: ATTEMPT_FIRST_CONTENT_TIMEOUT_MS })
      held = attemptHeld
      const headersTimeoutMs = patient
        ? options.headersTimeoutMs
        : Math.min(options.headersTimeoutMs ?? options.timeoutMs ?? ATTEMPT_HEADERS_TIMEOUT_MS, ATTEMPT_HEADERS_TIMEOUT_MS)

      // Handlers rewrite top-level fields of the request, so each attempt gets its own copy.
      const handled = handleMessagesRequest(
        { ...request },
        { ...memberConfig, pickedReasoningEffort: sessionConfig.pickedReasoningEffort },
        attemptHeld.response,
        { ...options, headersTimeoutMs }
      )
      handled.catch(error => attemptHeld.fail({ cause: 'error', message: errorMessage(error) }))
      const outcome = await attemptHeld.outcome

      if (outcome.kind === 'committed') {
        run.succeeded(attempt)
        open = null
        // Only a recovery or a move to another model is news; routine requests are not.
        if (attempt.index > 1 || attempt.probe) console.log(`[Router] group_served ${subject} after_failures=${failed.length}`)
        emitGroupRouteFact({ groupId: plan.id, sessionKey, phase: 'served', member, attempt: attempt.index, at: Date.now() })
        served = handled
        break
      }
      if (outcome.kind === 'abandoned') {
        run.abandoned(attempt)
        open = null
        break
      }

      const evidence = toFailureEvidence(outcome.failure, outcome.reply)
      const verdict = run.failed(attempt, evidence)
      open = null
      console.warn(`[Router] group_attempt_failed ${subject} kind=${evidence.kind}${evidence.kind === 'http' ? ` status=${evidence.status}` : ''} rest=${restNote(verdict)} blame=${verdict.blame}`)
      lastStatus = outcome.failure.cause === 'http' ? outcome.failure.status : undefined
      failed.push({ entry, evidence, error: lastFailureAsError(outcome.failure, outcome.reply) })
      previous = { member, reason: failureReason(evidence) }
    }

    const summary = run.finish()
    if (served) {
      await served
      return
    }
    if (clientGone) return

    const error = describeExhaustion(plan, summary, failed, Date.now())
    console.warn(`[Router] group_exhausted group=${plan.id} attempted=${summary.attempted.length} resting=${summary.resting.length} budget_spent=${summary.budgetSpent}`)
    emitGroupRouteFact({ groupId: plan.id, sessionKey, phase: 'exhausted', attempt: summary.attempted.length, at: Date.now() })
    // Once another member has been tried, the engine's own retries would only multiply the cost.
    const refuseRetry = new Set(failed.map(item => item.entry.member.key)).size >= 2
    // The failing provider's own status stays true; without one, the error's type decides.
    sendError(res, error.type, error.message, undefined, { refuseRetry, status: lastStatus ?? error.status })
  } catch (error) {
    if (open) run.abandoned(open)
    throw error
  } finally {
    run.finish()
    res.off('close', onClientClose)
  }
}
