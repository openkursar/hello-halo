import { getConversationEngineState, readConversationHandoffHistory, type Conversation } from '../conversation.service'
import type { EngineSessionState } from '../../../shared/types/engine-session'
import { planEngineHandoff, serializeEngineHandoff } from './engine-handoff'
import { getGoalDraft } from './goal/draft'
import { resolveHistoricalEngine } from './engine-migration'
import { waitForSdkInitialization } from './initialization'
import { getConfig } from '../../foundation/config.service'
import { isEngineId, type EngineId } from '../../../shared/types/engine'
import { getStartupEngine, resolveDefaultEngine, ensureEngineAvailable } from './resolved-sdk'

/** Old sessions have no engine binding; a live default change preserves their prior routing. */
export function getLegacyEngine(config = getConfig()): EngineId {
  const recorded = config.agent?.legacySdkEngine
  return resolveHistoricalEngine(isEngineId(recorded) ? recorded : getStartupEngine(), config)
}

/** Cold reads resolve historical ownership without probing or starting a runtime. */
export function getConversationEngineMetadata(
  conversation: Pick<Conversation, 'engineBinding' | 'engineRoutingVersion' | 'engineId' | 'engineOverride' | 'sessionId' | 'messageCount'> & Partial<Pick<Conversation, 'messages'>>,
  config = getConfig(),
): EngineId {
  const recorded = conversation.engineBinding?.engineId
    ?? (conversation.engineRoutingVersion === 1 && isEngineId(conversation.engineId) ? conversation.engineId : undefined)
  const configured = config.agent?.sdkEngine
  if (recorded) return conversation.engineOverride ? recorded : resolveHistoricalEngine(recorded, config)
  return conversation.engineOverride ?? (conversation.sessionId || (conversation.messages?.length ?? conversation.messageCount)
    ? getLegacyEngine(config) : resolveHistoricalEngine(isEngineId(configured) ? configured : 'halo', config))
}

/** Engine preferences never move an in-flight turn or silently repoint an existing binding. */
export async function resolveConversationEngine(
  conversation: Conversation | null | undefined,
  residentEngine?: EngineId,
  busy = false,
): Promise<EngineId> {
  await waitForSdkInitialization()
  if (busy && residentEngine) return residentEngine
  const requested = conversation?.engineOverride ?? conversation?.engineBinding?.engineId
    ?? (conversation?.engineRoutingVersion === 1 && isEngineId(conversation.engineId) ? conversation.engineId : undefined)
  if (isEngineId(requested)) {
    const engineId = conversation?.engineOverride ? requested : resolveHistoricalEngine(requested)
    await ensureEngineAvailable(engineId)
    return engineId
  }
  if (residentEngine) return residentEngine
  if (conversation?.sessionId || conversation?.messages.length) return getLegacyEngine()
  return resolveDefaultEngine()
}

export interface ConversationContinuation {
  engineId: EngineId
  engineState: EngineSessionState
  resumeSessionId?: string
  strictNativeResume?: boolean
  engineHandoffContent?: string
  historyTruncated?: boolean
}

/** Prepares a replacement from Halo's record without changing the current native binding. */
export async function prepareConversationContinuation(
  spaceId: string,
  conversationId: string,
  conversation: Conversation,
  engineId: EngineId,
  options: { beforeMessageId?: string; legacySessionId?: string; maxBytes?: number; forceHandoff?: boolean; excludedHistoryMessageIds?: readonly string[] } = {},
): Promise<ConversationContinuation> {
  const engineState = getConversationEngineState(spaceId, conversationId) ?? {}
  const boundary = options.beforeMessageId ? conversation.messages.findIndex(message => message.id === options.beforeMessageId) : conversation.messages.length
  const plan = planEngineHandoff({
    enabled: Boolean(engineState.binding || conversation.engineOverride || conversation.engineRoutingVersion === 1),
    targetEngine: engineId, binding: engineState.binding,
    legacySessionId: options.legacySessionId ?? engineState.sessionId,
    sourceEngine: engineState.binding?.engineId ?? (conversation.engineRoutingVersion === 1 && isEngineId(conversation.engineId) ? conversation.engineId : getLegacyEngine()),
    hasHistory: boundary > 0,
    compatibleNativeResume: !conversation.engineOverride && resolveHistoricalEngine('anthropic') === 'halo',
  })
  if (plan.kind !== 'handoff' && !options.forceHandoff) return { engineId, engineState, resumeSessionId: plan.resumeSessionId, strictNativeResume: plan.kind === 'resume' && engineState.binding?.engineId === engineId }
  const { getPendingConversationInputIds } = await import('../conversation-interop')
  const history = readConversationHandoffHistory(spaceId, conversationId, {
    beforeMessageId: options.beforeMessageId,
    excludeMessageIds: [...options.excludedHistoryMessageIds ?? [], ...getPendingConversationInputIds(conversationId)],
  })
  if (history.messages.length === 0 && engineState.sessionId) {
    console.warn(`[Agent][${conversationId}] Engine change refused: the native session has no readable Halo history`)
    throw new Error('This conversation has no readable history to transfer. Keep using its current engine or start a new conversation.')
  }
  const lastGoal = [...conversation.messages].reverse().find(message => message.metadata?.goal)?.metadata?.goal
  const context = serializeEngineHandoff({
    ...history, historyTruncated: history.truncated,
    targetEngine: engineId, sourceEngine: plan.sourceEngine,
    goal: getGoalDraft(conversationId) ?? lastGoal,
    maxBytes: options.maxBytes,
  })
  console.log(`[Agent][${conversationId}] Engine context prepared: ${plan.sourceEngine ?? 'legacy'}→${engineId}, messages=${context.includedMessages}, truncated=${context.truncated}`)
  return { engineId, engineState, engineHandoffContent: context.text, historyTruncated: context.truncated }
}
