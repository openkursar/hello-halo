import type { Message, Thought } from '../types'
import type { LiveInput } from '../types/live-input'
import { isTeamTranscriptMessage, sameTranscriptInput } from '../../shared/transcript'

const MAX_LIVE_INPUTS = 128
const MAX_LIVE_INPUT_BYTES = 8 * 1024 * 1024

/** Provisional ids, replaced once the transcript is read back: a sender's optimistic bubble, or a record as announced. */
const PROVISIONAL_ID = 'pending-'
const ANNOUNCED_ID = 'pending-live-'

/**
 * Whether `held` is `record` itself or its stored twin: the same id (a stored
 * twin keeps the announced id as its client key), or the writer's original
 * timestamp with the same source and content. A provisional id carries no
 * writer timestamp to compare.
 */
export function isSameInputRecord(held: Message, record: Message): boolean {
  return held.id === record.id || held.clientKey === record.id
    || (!held.id.startsWith(PROVISIONAL_ID) && held.timestamp === record.timestamp && sameTranscriptInput(held, record))
}

/** Whether `held` is its sender's optimistic bubble for `record`; a person's team chat record also names its trigger. */
export function isOptimisticTwin(held: Message, record: Message): boolean {
  if (!held.id.startsWith(PROVISIONAL_ID) || held.id.startsWith(ANNOUNCED_ID)) return false
  if (sameTranscriptInput(held, record)) return true
  if (record.metadata?.teamTriggerKind !== 'human_message') return false
  const { teamTriggerKind: _kind, correlationId: _correlation, ...metadata } = record.metadata
  return sameTranscriptInput(held, { ...record, metadata })
}

/** Merge arrival deltas without replacing history or duplicating an optimistic sender bubble. */
export function mergeArrivingMessages(prior: readonly Message[], arrivals: readonly Message[]): Message[] {
  const merged = [...prior]
  for (const message of arrivals) {
    if (merged.some(item => isSameInputRecord(item, message))) continue
    const optimistic = merged.findIndex(item => isOptimisticTwin(item, message))
    if (optimistic >= 0) merged[optimistic] = { ...message, clientKey: merged[optimistic].clientKey ?? merged[optimistic].id }
    else merged.push(message)
  }
  return merged
}

/**
 * Carry a stop's outcome onto the person's inputs it voided: the stored record,
 * the record as announced, or the sender's own optimistic bubble. A voided input
 * this view never showed is added, so it still reads as sent and not handled.
 */
export function withStoppedInputs(prior: readonly Message[], stopped: readonly Message[]): Message[] {
  if (stopped.length === 0) return prior as Message[]
  const next = [...prior]
  for (const record of stopped) {
    let at = next.findIndex(item => isSameInputRecord(item, record))
    if (at < 0) at = next.findIndex(item => isOptimisticTwin(item, record))
    if (at < 0) next.push({ ...record, clientKey: record.id })
    else next[at] = { ...next[at], metadata: { ...next[at].metadata, inputOutcome: 'stopped' } }
  }
  return next
}

/** The same outcome on the running turn's placement overlay. */
export function withStoppedLiveInputs(inputs: readonly LiveInput[], stopped: readonly Message[]): LiveInput[] {
  let changed = false
  const next = inputs.map(input => {
    if (!stopped.some(record => isSameInputRecord(input.message, record))) return input
    changed = true
    return { ...input, message: { ...input.message, metadata: { ...input.message.metadata, inputOutcome: 'stopped' as const } } }
  })
  return changed ? next : inputs as LiveInput[]
}

/** Old arrivals remain in the transcript; only the active stream's placement overlay is bounded. */
export function appendLiveInputs(prior: readonly LiveInput[], arrivals: readonly Message[], anchor: Omit<LiveInput, 'message'>): LiveInput[] {
  const known = new Set(prior.map(input => input.message.id))
  const next = [...prior, ...arrivals.filter(message => !known.has(message.id)).map(message => ({ ...anchor, message }))]
  const kept = new Set<LiveInput>()
  let bytes = 0
  // Team reports do not partition the reply, so they must not evict a person's text anchor.
  for (const team of [false, true]) {
    for (let at = next.length - 1; at >= 0 && kept.size < MAX_LIVE_INPUTS; at--) {
      const input = next[at]
      if (isTeamTranscriptMessage(input.message) !== team) continue
      const weight = (input.message.content.length + (input.textSnapshot?.length ?? 0)) * 2 + (input.message.images ?? []).reduce((sum, image) => sum + image.data.length * 2, 0)
      if (bytes + weight > MAX_LIVE_INPUT_BYTES) break
      bytes += weight
      kept.add(input)
    }
  }
  return next.filter(input => kept.has(input))
}

/** Arrivals in the live stream are not drawn a second time by a concurrent transcript refresh. */
export function withoutLiveInputs(messages: readonly Message[], inputs: readonly LiveInput[]): Message[] {
  if (inputs.length === 0) return messages as Message[]
  const claimed = new Set<number>()
  return messages.filter(message => {
    const index = inputs.findIndex((input, at) => !claimed.has(at) && isSameInputRecord(message, input.message))
    if (index < 0) return true
    claimed.add(index)
    return false
  })
}

export interface LiveInputSection {
  input: LiveInput
  thoughts: Thought[]
  text: string
}

/** Linear merge of arrival anchors with the existing thought order; no transcript scan or sort. */
export function splitLiveInputSections(thoughts: Thought[], version: number, inputs: readonly LiveInput[], previous: readonly LiveInputSection[] = []): {
  sections: LiveInputSection[]
  thoughts: Thought[]
  textOffset: number
} {
  if (inputs.length === 0) return { sections: [], thoughts, textOffset: 0 }
  const positions = new Map(thoughts.map((thought, index) => [thought.id, index + 1]))
  const oldSections = new Map(previous.map(section => [section.input.message.id, section]))
  const textOffsets = new Map<number, number>()
  let thoughtFrom = 0
  const sections = inputs.map(input => {
    const thoughtTo = Math.max(thoughtFrom, input.afterThoughtId ? positions.get(input.afterThoughtId) ?? thoughtFrom : 0)
    const textFrom = textOffsets.get(input.textBlockVersion) ?? 0
    const section = { input, thoughts: thoughts.slice(thoughtFrom, thoughtTo), text: input.textSnapshot?.slice(textFrom, input.textOffset) ?? '' }
    const old = oldSections.get(input.message.id)
    if (old && old.thoughts.length === section.thoughts.length && old.thoughts.every((thought, index) => thought === section.thoughts[index])) section.thoughts = old.thoughts
    thoughtFrom = thoughtTo
    textOffsets.set(input.textBlockVersion, input.textOffset)
    return section
  })
  return { sections, thoughts: thoughts.slice(thoughtFrom), textOffset: textOffsets.get(version) ?? 0 }
}
