/**
 * Agent Module - How a finished stream left its reply
 *
 * The record of a reply that ended before its answer was done, so a transcript
 * read later can still say so after the live notice is gone. Mirrors the
 * decision behind the stream processor's end-of-turn notice; a failed request
 * is the reply's error, and a stop Halo made on purpose (waiting for the
 * person's answer) is not an ending.
 */

import type { ReplyEnding } from '../../../shared/types/transcript'
import type { StreamResult } from './stream-processor'

export function replyEndingOf(result: Pick<StreamResult,
  'hasErrorThought' | 'drainTimedOut' | 'reachedMaxTurns' | 'wasAborted' | 'stopReason' | 'isInterrupted'>): ReplyEnding | undefined {
  if (result.hasErrorThought) return undefined
  if (result.drainTimedOut) return 'interrupted'
  if (result.reachedMaxTurns) return 'step-limit'
  if (result.wasAborted) return result.stopReason === 'internal' ? undefined : 'stopped'
  return result.isInterrupted ? 'interrupted' : undefined
}
