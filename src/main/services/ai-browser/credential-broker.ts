/**
 * AI Browser - credential broker
 *
 * Some logins need a PIN or a one-time token that must not pass through the
 * model: text the model is given, it can also write into a transcript, a log,
 * or a page of its own choosing. The broker is the only path for such text —
 * the model asks for a field by uid, the user types the value, and it is held
 * in memory for exactly one fill before being dropped.
 *
 * What this does not do: once the text sits in the page's own input, the page
 * can read it back, and so can anything driving that page. The broker closes
 * the transcript path, not the page — which is why the fill and the submit
 * happen inside a single tool call, with no model turn in between.
 *
 * Nothing here is persisted and no value is ever logged.
 */

import { randomUUID } from 'node:crypto'
import type { AIBrowserCredentialRequest, AIBrowserSecretField } from '../../../shared/types/ai-browser'
import { emitBrowserCredentialRequest, emitBrowserCredentialResolved } from './events'

/**
 * How long a prompt stays answerable. Long enough to read a token off a
 * hardware key or an authenticator app, short enough that an unanswered
 * prompt cannot pin a page operation open indefinitely.
 */
export const CREDENTIAL_WAIT_MS = 120_000

export type CredentialOutcome =
  | { status: 'provided'; values: ReadonlyMap<string, string> }
  | { status: 'declined' }
  | { status: 'expired' }

interface PendingRequest {
  detail: AIBrowserCredentialRequest
  timer: NodeJS.Timeout
  settle: (outcome: CredentialOutcome) => void
  dispose: () => void
}

const pending = new Map<string, PendingRequest>()

function finish(requestId: string, outcome: CredentialOutcome): void {
  const entry = pending.get(requestId)
  if (!entry) return
  clearTimeout(entry.timer)
  entry.dispose()
  pending.delete(requestId)
  entry.settle(outcome)
  emitBrowserCredentialResolved({ requestId, outcome: outcome.status })
  console.log(`[BrowserCredential] ${outcome.status} for page ${entry.detail.viewId}`)
}

/**
 * Ask the user to type one or more values into the named fields, and wait.
 *
 * Resolves rather than rejects on every ending, so the caller reports what
 * happened instead of surfacing a timeout as a browser failure.
 */
export function requestCredential(request: {
  conversationId: string | null
  spaceId: string | null
  viewId: string
  origin: string
  title: string | null
  fields: AIBrowserSecretField[]
  purpose: string
}, signal?: AbortSignal): Promise<CredentialOutcome> {
  if (signal?.aborted) return Promise.resolve({ status: 'expired' })
  const requestId = randomUUID()
  const detail: AIBrowserCredentialRequest = { requestId, ...request, expiresAt: Date.now() + CREDENTIAL_WAIT_MS }
  return new Promise<CredentialOutcome>(resolve => {
    const expire = () => finish(requestId, { status: 'expired' })
    const timer = setTimeout(expire, CREDENTIAL_WAIT_MS)
    timer.unref()
    pending.set(requestId, { detail, timer, settle: resolve, dispose: () => signal?.removeEventListener('abort', expire) })
    signal?.addEventListener('abort', expire, { once: true })
    emitBrowserCredentialRequest(detail)
  })
}

/**
 * Hand over what the user typed. Accepted once: the values are consumed by the
 * waiting fill, so a second submission for the same request has nothing left
 * to answer and is refused rather than queued.
 */
export function submitCredential(requestId: string, values: Record<string, string>): { accepted: boolean; error?: string } {
  const entry = pending.get(requestId)
  if (!entry) return { accepted: false, error: 'This request is no longer waiting for input' }
  const collected = new Map<string, string>()
  for (const field of entry.detail.fields) {
    const value = values[field.uid]
    if (!Object.hasOwn(values, field.uid) || typeof value !== 'string' || value.length === 0 || value.length > 4096) {
      return { accepted: false, error: 'Enter a value of up to 4096 characters for each field' }
    }
    collected.set(field.uid, value)
  }
  finish(requestId, { status: 'provided', values: collected })
  return { accepted: true }
}

/** Refuse the request; the page is left untouched and the model is told so. */
export function declineCredential(requestId: string): { accepted: boolean; error?: string } {
  if (!pending.has(requestId)) return { accepted: false, error: 'This request is no longer waiting for input' }
  finish(requestId, { status: 'declined' })
  return { accepted: true }
}

/**
 * Abandon every request whose page is gone. Without this the user would be
 * asked to type a code into a page that can no longer receive it, and the
 * waiting tool call would sit out the full timeout to learn the same thing.
 */
export function abandonCredentialRequestsForView(viewId: string): void {
  for (const [requestId, entry] of pending) {
    if (entry.detail.viewId === viewId) finish(requestId, { status: 'expired' })
  }
}

/**
 * Abandon every request a conversation left behind. Its pages can outlive it —
 * a space chat's tabs stay the user's — but the tool call that would have used
 * the text is gone with the conversation, so the prompt has nothing to feed.
 */
export function abandonCredentialRequestsForConversation(conversationId: string | null): void {
  if (!conversationId) return
  for (const [requestId, entry] of pending) {
    if (entry.detail.conversationId === conversationId) finish(requestId, { status: 'expired' })
  }
}

/**
 * Requests still waiting, for a client that connected after the prompt was
 * emitted. Carries the same value-free payload as the event.
 */
export function listPendingCredentialRequests(): AIBrowserCredentialRequest[] {
  return Array.from(pending.values(), entry => entry.detail)
}
