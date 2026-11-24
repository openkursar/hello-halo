/**
 * Records that joined a reply while it was being written — a teammate's
 * message, or another conversation's — drawn inside that reply's process at
 * the point they were received, while the turn runs and after a reload alike.
 *
 * Ownership is stated by the writer: such a record names the reply open at
 * receipt (`inputMode: 'live'`, `inputReplyId`). Adjacency or timestamps never
 * attach a record; one that opened a turn is drawn on the reply it opened
 * (see transcript-rows), and one that names no drawn reply stays a card of its own.
 */

import type { LiveInput, Message, Thought } from '../../../types'
import { isTeamTranscriptMessage } from '../../../../shared/transcript'
import { isSameInputRecord } from '../../../utils/live-inputs'

export interface ArrivalThought extends Thought {
  arrival: Message
}

/** Kinds of record drawn among a reply's work when they join it mid-turn. */
export function isArrivalRecord(message: Message): boolean {
  return isTeamTranscriptMessage(message) || (message.role === 'system' && message.source === 'cross-conversation')
}

/** Whether `message` was received while `reply` was being written. */
export function arrivedDuring(message: Message, reply: Message | undefined): boolean {
  return reply?.role === 'assistant' && reply.source !== 'push' && isArrivalRecord(message)
    && message.metadata?.inputMode === 'live' && message.metadata.inputReplyId === reply.id
}

/** A stored reply that has produced nothing yet: the running turn's placeholder. */
function isOpenPlaceholder(message: Message): boolean {
  return message.role === 'assistant' && message.source !== 'push' && !message.content && !message.error
    && !message.tokenUsage && !message.thoughtsSummary && !message.thoughts?.length
}

function isDrawnReply(message: Message): boolean {
  return message.role === 'assistant' && message.source !== 'push' && !isOpenPlaceholder(message)
}

/**
 * The running turn's arrivals, recovered from the stored records (which keep
 * every arrival) rather than from the bounded placement overlay. While a turn
 * runs its partial reply is drawn from the stream, not from the transcript, so
 * an arrival stored after the turn's start that names no reply, the open
 * placeholder, or a reply the transcript does not hold belongs to the turn on
 * screen. The start is the stored placeholder, or the input that opened the turn.
 */
export function liveArrivals(messages: readonly Message[], inputs: readonly LiveInput[]): Message[] {
  let from = messages.length
  while (from > 0 && !isDrawnReply(messages[from - 1])) from--
  const replies = new Set<string>()
  let placeholder: string | undefined
  let start = from
  for (let at = Math.max(0, from - 1); at < messages.length; at++) {
    const message = messages[at]
    if (message.role === 'assistant') replies.add(message.id)
    if (at < from) continue
    if (isOpenPlaceholder(message)) placeholder = message.id
    if (isOpenPlaceholder(message) || (message.role === 'user' && message.source !== 'injection')) start = at + 1
  }
  const announced = inputs.filter(input => isArrivalRecord(input.message)).map(input => input.message)
  const matched = new Set<Message>()
  const result: Message[] = []
  for (let at = from; at < messages.length; at++) {
    const message = messages[at]
    if (!isArrivalRecord(message)) continue
    const arrival = announced.find(input => !matched.has(input) && isSameInputRecord(message, input))
    if (arrival) matched.add(arrival)
    const replyId = message.metadata?.inputReplyId
    const open = at >= start && message.metadata?.inputMode === 'live'
      && (!replyId || replyId === placeholder || !replies.has(replyId))
    if (arrival || open) result.push(message)
  }
  for (const message of announced) if (!matched.has(message)) result.push(message)
  return result
}

export function toArrivalThought(message: Message): ArrivalThought {
  return { id: `arrival:${message.clientKey ?? message.id}`, type: 'system', content: message.content, timestamp: message.timestamp, arrival: message }
}

export function isArrivalThought(thought: Thought): thought is ArrivalThought {
  return 'arrival' in thought
}

/** Seconds from the reply's first to its last own step; a record it received is not its work. */
export function workSeconds(thoughts: readonly Thought[]): number {
  let first = 0
  while (first < thoughts.length && isArrivalThought(thoughts[first])) first++
  if (first === thoughts.length) return 0
  let last = thoughts.length - 1
  while (isArrivalThought(thoughts[last])) last--
  return (new Date(thoughts[last].timestamp).getTime() - new Date(thoughts[first].timestamp).getTime()) / 1000
}

/** Thought objects are reused for unchanged records, so drawn items keep their identity. */
export function projectArrivalThoughts(messages: readonly Message[], previous: readonly ArrivalThought[] = []): ArrivalThought[] {
  const prior = new Map(previous.map(thought => [thought.arrival, thought]))
  return messages.map(message => prior.get(message) ?? toArrivalThought(message))
}

/** Records stay as stored; only their presentation joins the work timeline, by time of receipt. */
export function mergeArrivalThoughts(thoughts: Thought[], arrivals: readonly ArrivalThought[]): Thought[] {
  if (arrivals.length === 0) return thoughts
  const ordered = arrivals.length > 1 ? [...arrivals].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)) : arrivals
  const merged: Thought[] = []
  let at = 0
  for (const thought of thoughts) {
    while (at < ordered.length && ordered[at].timestamp <= thought.timestamp) merged.push(ordered[at++])
    merged.push(thought)
  }
  return [...merged, ...ordered.slice(at)]
}
