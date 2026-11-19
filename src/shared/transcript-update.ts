/**
 * Incremental transcript reads.
 *
 * A reader that already holds a transcript passes back the `cursor` of its
 * last read and receives only what changed since: the messages from the first
 * one that changed, and in each of them only the thoughts that changed. The
 * rest it keeps. Applying an update to what the reader held yields exactly the
 * whole transcript at the time of the update; when the reader cannot apply it
 * (it holds something else), it reads the whole transcript again.
 *
 * Pure (renderer-safe, no Electron/Node).
 */

import type { Thought, TranscriptMessage } from './types/transcript'

/** A message of an update whose unchanged thoughts were left out. */
export interface TranscriptUpdateMessage extends TranscriptMessage {
  /**
   * Present when `thoughts` holds only the changed thoughts: the length of the
   * full list and where each sent thought stands in it. The other places take
   * the thoughts the reader already holds for this message, in their order.
   */
  thoughtPatch?: { total: number; at: number[] }
}

export interface TranscriptUpdate {
  /** Pass back as `since` to receive what changes after this read. */
  cursor: string
  /**
   * How many leading messages the reader keeps; `messages` replaces the rest.
   * Absent: `messages` is the whole transcript.
   */
  keep?: number
  /** Id of the last kept message, so the reader can check it holds the same history. */
  keepThrough?: string
  messages: TranscriptUpdateMessage[]
}

/**
 * The whole transcript after `update`, given what the reader held; null when
 * the update does not fit what it holds (the reader then reads it whole).
 */
export function applyTranscriptUpdate<T extends TranscriptMessage>(held: readonly T[], update: TranscriptUpdate): T[] | null {
  if (update.keep === undefined) {
    return update.messages.some(message => message.thoughtPatch) ? null : update.messages as unknown as T[]
  }
  const keep = update.keep
  if (keep > held.length) return null
  if (keep > 0 && held[keep - 1]?.id !== update.keepThrough) return null
  if (keep === held.length && update.messages.length === 0) return held as T[]
  const heldById = new Map<string, T>()
  for (let index = keep; index < held.length; index++) heldById.set(held[index].id, held[index])
  const next: T[] = held.slice(0, keep)
  for (const message of update.messages) {
    const { thoughtPatch, ...rest } = message
    if (!thoughtPatch) {
      next.push(rest as unknown as T)
      continue
    }
    const previous = heldById.get(message.id)
    const thoughts = patchThoughts(previous?.thoughts, message.thoughts ?? [], thoughtPatch)
    if (!thoughts) return null
    next.push({ ...rest, thoughts } as unknown as T)
  }
  return next
}

function patchThoughts(
  held: Thought[] | null | undefined,
  sent: Thought[],
  patch: { total: number; at: number[] },
): Thought[] | null {
  if (patch.at.length !== sent.length) return null
  const sentIds = new Set(sent.map(thought => thought.id))
  const kept = (held ?? []).filter(thought => !sentIds.has(thought.id))
  if (kept.length !== patch.total - sent.length) return null
  const thoughts: Array<Thought | undefined> = new Array(patch.total)
  for (let index = 0; index < sent.length; index++) {
    const at = patch.at[index]
    if (!Number.isInteger(at) || at < 0 || at >= patch.total || thoughts[at]) return null
    thoughts[at] = sent[index]
  }
  let next = 0
  for (let index = 0; index < patch.total; index++) {
    if (!thoughts[index]) thoughts[index] = kept[next++]
  }
  return thoughts as Thought[]
}
