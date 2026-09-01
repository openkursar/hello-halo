/**
 * Agent Module - Turn Sink
 *
 * Where a consumed turn's output goes.
 *
 * The session consumer owns turn *consumption*: one persistent loop per V2
 * session that keeps re-entering `stream()`, so CC output is never left unread
 * between turns. What a finished turn *means* is surface-specific — a space
 * conversation persists through conversation.service and renders in the chat
 * UI; a digital human persists to JSONL and may owe a reply to an IM channel.
 * A TurnSink is that second half.
 *
 * Keeping the split here is what allows every chat entry point to share one
 * consumption model: a new entry point supplies a sink, never its own loop.
 */

import type { StreamResult } from './stream-processor'

export interface TurnSink {
  /**
   * CC acknowledged a turn (`system:init`). Always precedes that turn's
   * `onRawMessage` calls; a stream that never inits never reaches the other
   * hooks either.
   */
  onTurnStart?(): void

  /** Every raw SDK message of the current turn, in arrival order. */
  onRawMessage?(sdkMessage: unknown): void

  /**
   * The turn's stream ended. Also reached for aborted and error-carrying
   * streams — inspect the result flags rather than assuming success.
   */
  onTurnComplete(result: StreamResult): void

  /**
   * The turn threw instead of completing.
   *
   * @param turnStarted whether `onTurnStart` had fired for this turn — false
   *   means the failure happened before CC acknowledged anything, so no
   *   turn-scoped state exists to update.
   */
  onTurnError?(error: Error, turnStarted: boolean): void

  /**
   * The consumer loop exited: no further turn will arrive on this session.
   * Sinks that hand out per-turn promises must settle the outstanding ones
   * here, or their callers wait forever.
   */
  onConsumerStopped?(): void
}
