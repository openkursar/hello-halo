/**
 * Bringing something in front of the user: main asks every client, each one
 * answers what it did, and the best answer is the outcome.
 *
 * Only a client can tell whether a person is looking at the conversation and
 * whether they are typing, so the decision is the client's; main only gathers
 * the answers. The transport forwards each request and says how many clients
 * it reached, so the wait ends as soon as all of them answered (or one showed
 * it), and a client that never answers costs at most the reply window.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import type {
  CanvasShowClientOutcome,
  CanvasShowReply,
  CanvasShowRequest,
} from '../../../shared/types/canvas-show'

/** `absent`: no client answered — nobody has Halo open. */
export type CanvasShowOutcome = CanvasShowClientOutcome | 'absent'

const REPLY_WINDOW_MS = 3000

interface PendingRequest {
  expected: number | null
  replies: CanvasShowClientOutcome[]
  finish: (timedOut?: boolean) => void
}

const requests = new EventEmitter()
requests.setMaxListeners(0)
const pending = new Map<string, PendingRequest>()

function bestOutcome(replies: readonly CanvasShowClientOutcome[]): CanvasShowOutcome {
  if (replies.includes('shown')) return 'shown'
  if (replies.includes('opened')) return 'opened'
  if (replies.includes('added')) return 'added'
  return replies.length > 0 ? 'unavailable' : 'absent'
}

function settleIfComplete(entry: PendingRequest): void {
  if (entry.replies.includes('shown')) entry.finish()
  else if (entry.expected !== null && entry.replies.length >= entry.expected) entry.finish()
}

export function requestCanvasShow(request: Omit<CanvasShowRequest, 'requestId' | 'replyWithinMs'>): Promise<CanvasShowOutcome> {
  const requestId = randomUUID()
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const entry: PendingRequest = {
      expected: null,
      replies: [],
      finish: (timedOut) => {
        if (!pending.delete(requestId)) return
        if (timer) clearTimeout(timer)
        if (timedOut) {
          console.warn('[CanvasShow] Client reply window expired', { requestId, expected: entry.expected, received: entry.replies.length })
        }
        resolve(bestOutcome(entry.replies))
      },
    }
    pending.set(requestId, entry)
    timer = setTimeout(() => entry.finish(true), REPLY_WINDOW_MS)
    requests.emit('request', { ...request, requestId, replyWithinMs: REPLY_WINDOW_MS } satisfies CanvasShowRequest)
    if (requests.listenerCount('request') === 0) entry.finish()
  })
}

/** Called by the transport for each request it forwarded: how many clients it reached. */
export function expectCanvasShowReplies(requestId: string, clients: number): void {
  const entry = pending.get(requestId)
  if (!entry) return
  entry.expected = (entry.expected ?? 0) + clients
  settleIfComplete(entry)
}

/** A client's answer as it arrived over a transport; returns false for anything malformed. */
export function receiveCanvasShowReply(value: unknown): boolean {
  const reply = value as Partial<CanvasShowReply> | null
  if (!reply || typeof reply.requestId !== 'string') return false
  if (reply.outcome !== 'shown' && reply.outcome !== 'opened' && reply.outcome !== 'added' && reply.outcome !== 'unavailable') return false
  const entry = pending.get(reply.requestId)
  if (!entry) return true
  entry.replies.push(reply.outcome)
  settleIfComplete(entry)
  return true
}

/** The transport's subscription; it forwards each request to every client. */
export function onCanvasShowRequest(handler: (request: CanvasShowRequest) => void): () => void {
  requests.on('request', handler)
  return () => requests.off('request', handler)
}
