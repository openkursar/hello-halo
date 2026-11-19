import type { Thought } from './types/transcript'

/** Stored wording of a compaction step; the chat shows its own translation, other readers this. */
export const COMPACTION_STEP_TEXT = 'Context compacted'

/** The compaction an engine's `compact_boundary` frame reports, if `frame` is one. */
export function readCompaction(frame: { type?: unknown; subtype?: unknown; compact_metadata?: unknown }): Thought['compaction'] | undefined {
  if (frame.type !== 'system' || frame.subtype !== 'compact_boundary') return undefined
  const trigger = (frame.compact_metadata as { trigger?: unknown } | undefined)?.trigger
  return { trigger: trigger === 'manual' ? 'manual' : 'auto' }
}
