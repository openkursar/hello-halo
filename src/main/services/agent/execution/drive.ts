/**
 * Reading an engine session for an entry that drives its own stream.
 *
 * A conversation's consumer never leaves the stream, so conversation entries do
 * not use this; a headless run has no consumer of its own, and reads here until
 * the engine has ended and nothing the execution owns is unfinished or unread.
 */

import type { RunTokenUsage } from '../../../../shared/apps/app-types'
import type { ExecutionReader, ExecutionSessionPort } from './types'
import { readResultUsage } from '../result-usage'

/** What reading needs from the execution it belongs to. */
export interface DriveSurface {
  /** The execution has not been stopped or closed. */
  isLive(): boolean
  /** Resolves true when the engine will have more to read: unread input, or owned work still to report. */
  awaitContinuation(): Promise<boolean>
  addUsage(usage: RunTokenUsage | undefined): void
  /** The reader ended the execution: nothing more is admitted. */
  closeAdmission(): void
}

function isResultFrame(frame: unknown): frame is { type: 'result'; is_error?: boolean; error_during_execution?: boolean } {
  return typeof frame === 'object' && frame !== null && (frame as { type?: unknown }).type === 'result'
}

export async function driveSession(
  session: ExecutionSessionPort,
  surface: DriveSurface,
  reader: ExecutionReader,
): Promise<void> {
  let failed = false
  let ended = false
  do {
    for await (const frame of session.stream()) {
      if (isResultFrame(frame)) {
        surface.addUsage(readResultUsage(frame))
        if (frame.is_error || frame.error_during_execution) failed = true
      }
      if (reader.onMessage(frame) === 'stop') {
        ended = true
        surface.closeAdmission()
        break
      }
    }
  } while (!ended && surface.isLive() &&
    (session.hasPendingInput?.() === true || (!failed && await surface.awaitContinuation())))
}
