import { isEngineId, type EngineId } from './engine'
import type { TranscriptMessage } from './transcript'

/** The one native session currently backing a Halo conversation. */
export interface EngineSessionBinding {
  version: 1
  engineId: EngineId
  sessionId: string
}

/** Chosen before creating the first native session, so a failed start keeps its routing. */
export interface EngineSessionRouting {
  version: 1
  engineId: EngineId
}

/** Captured before preparing a replacement; used to reject late writes from an older session. */
export interface EngineSessionState {
  sessionId?: string
  binding?: EngineSessionBinding
  routingEngine?: EngineId
}

export function isEngineSessionRouting(value: unknown): value is EngineSessionRouting {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'sessionId' in value) return false
  const candidate = value as Partial<EngineSessionRouting>
  return candidate.version === 1 && isEngineId(candidate.engineId)
}

export function isEngineSessionBinding(value: unknown): value is EngineSessionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<EngineSessionBinding>
  return candidate.version === 1
    && isEngineId(candidate.engineId)
    && typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0 && candidate.sessionId.length <= 512
}

export function sameEngineSessionState(left: EngineSessionState, right: EngineSessionState): boolean {
  return left.sessionId === right.sessionId
    && left.routingEngine === right.routingEngine
    && left.binding?.version === right.binding?.version
    && left.binding?.engineId === right.binding?.engineId
    && left.binding?.sessionId === right.binding?.sessionId
}

export interface EngineHandoffHistory {
  messages: TranscriptMessage[]
  truncated: boolean
  transcriptPath?: string
  completeRecordPaths?: string[]
  latestMessageId?: string
}

/** A bound native session was not restored; callers must preserve history before rebuilding. */
export class NativeSessionResumeError extends Error {
  readonly code = 'NATIVE_SESSION_RESUME_FAILED'

  constructor(readonly engineId: EngineId, readonly sessionId: string, cause?: unknown) {
    super('The saved engine session could not be restored', { cause })
    this.name = 'NativeSessionResumeError'
  }
}

export function isNativeSessionResumeError(value: unknown): value is NativeSessionResumeError {
  return value instanceof NativeSessionResumeError
    || Boolean(value && typeof value === 'object'
      && (value as { code?: unknown }).code === 'NATIVE_SESSION_RESUME_FAILED'
      && isEngineId((value as { engineId?: unknown }).engineId)
      && typeof (value as { sessionId?: unknown }).sessionId === 'string')
}
