import type { EngineId } from '../../../shared/types/engine'
import type { EngineSessionBinding, EngineSessionState } from '../../../shared/types/engine-session'
import {
  ensureEngineAvailable,
  getLegacyEngine,
  getSessionEngineId,
  isSessionBusy,
  resolveDefaultEngine,
  planEngineHandoff,
  serializeEngineHandoff,
} from '../../services/agent'
import { readChatHandoffHistory, resolveTranscriptPath } from './session-store'

interface AppEngineSelection {
  engineId?: EngineId
  conversationId?: string
  binding?: EngineSessionBinding
  routingEngine?: EngineId
  legacySessionId?: string
}

/** A running session keeps its engine; an explicit preference applies at its next idle turn. */
export async function resolveAppSessionEngine(selection: AppEngineSelection): Promise<EngineId> {
  const resident = selection.conversationId ? getSessionEngineId(selection.conversationId) : undefined
  if (resident && selection.conversationId && isSessionBusy(selection.conversationId)) return resident
  const engineId = selection.engineId ?? resident ?? selection.binding?.engineId ?? selection.routingEngine
      ?? (selection.legacySessionId ? getLegacyEngine() : await resolveDefaultEngine())
  await ensureEngineAvailable(engineId)
  return engineId
}

export function prepareAppEngineSession(options: {
  engineId: EngineId
  state: EngineSessionState
  legacySessionId?: string
  spacePath: string
  appId: string
  runId: string
  excludeInputIds?: readonly string[]
  readPendingInputIds?: () => readonly string[]
  conversationId?: string
}): { resumeSessionId?: string; engineHandoffContent?: string; strictNativeResume?: boolean; recoverNativeSession?: () => string } {
  const legacySessionId = options.state.sessionId ?? options.legacySessionId
  if (options.conversationId && getSessionEngineId(options.conversationId) === options.engineId && isSessionBusy(options.conversationId) && options.state.binding?.engineId !== options.engineId) {
    return { resumeSessionId: legacySessionId }
  }
  const plan = planEngineHandoff({
    enabled: Boolean(options.state.binding) || !legacySessionId || options.engineId !== getLegacyEngine(),
    targetEngine: options.engineId,
    binding: options.state.binding,
    legacySessionId,
    sourceEngine: options.state.binding?.engineId ?? options.state.routingEngine ?? (legacySessionId ? getLegacyEngine() : undefined),
    hasHistory: Boolean(legacySessionId || options.state.binding || resolveTranscriptPath(options.spacePath, options.appId, options.runId)),
  })
  const recoverNativeSession = () => {
    const history = readChatHandoffHistory(options.spacePath, options.appId, options.runId, { excludeInputIds: [...options.excludeInputIds ?? [], ...options.readPendingInputIds?.() ?? []] })
    if (!history.transcriptPath || (history.messages.length === 0 && (legacySessionId || options.state.binding))) {
      console.warn('[AppRuntime] Engine handoff refused without its prior transcript', { appId: options.appId, runId: options.runId, engineId: options.engineId, reason: history.transcriptPath ? 'empty-record' : 'missing-record' })
      throw new Error('The previous conversation record is unavailable. Restore it or start a new conversation before continuing.')
    }
    return serializeEngineHandoff({
      messages: history.messages,
      targetEngine: options.engineId,
      sourceEngine: plan.sourceEngine,
      transcriptPath: history.transcriptPath,
      historyTruncated: history.truncated,
    }).text
  }
  if (plan.kind === 'resume' && options.state.binding) return { resumeSessionId: plan.resumeSessionId, strictNativeResume: true, recoverNativeSession }
  if (plan.kind !== 'handoff') return { resumeSessionId: plan.resumeSessionId }
  return { engineHandoffContent: recoverNativeSession() }
}
