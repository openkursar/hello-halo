import type { EffectiveReasoning, ModelSelectionSnapshot } from '@hello-halo/agent-sdk/collaboration'
import type { AgentModelSelection } from '../../../shared/types/ai-sources'
import type { EngineId } from '../../../shared/types/engine'
import { captureEffectiveReasoning, delegatedReasoningLevel, pickReasoningEffort, UnrepresentableReasoningError } from './reasoning-effort'
import type { ReasoningEffortLevel } from '../../../shared/constants/reasoning-effort'
import type { ResolvedModelCapabilities } from './types'

/** The resolved execution behind a delegation, never a pending UI selection. */
export interface DelegatedModelContext {
  selection: AgentModelSelection
  engineId: EngineId
  reasoning?: EffectiveReasoning
  reasoningLevel?: ReasoningEffortLevel
  modelBinding?: ModelSelectionSnapshot
}

const sessionModels = new WeakMap<object, DelegatedModelContext>()

export function setSessionDelegatedModelContext(session: object, context: DelegatedModelContext): void {
  sessionModels.set(session, context)
}

export function getSessionDelegatedModelContext(session: object | undefined): DelegatedModelContext | undefined {
  return session ? sessionModels.get(session) : undefined
}

export function captureDelegatedModelContext(
  selection: AgentModelSelection,
  engineId: EngineId,
  options: Record<string, unknown>,
  modelBinding?: ModelSelectionSnapshot,
  capabilities?: ResolvedModelCapabilities,
  inheritedLevel?: ReasoningEffortLevel,
): DelegatedModelContext {
  const reasoningLevel = inheritedLevel ?? pickReasoningEffort(options.pickedReasoningEffort, options.reasoningEffort)
  let reasoning: EffectiveReasoning
  try {
    reasoning = captureEffectiveReasoning(options, engineId, capabilities)
  } catch (error) {
    if (!(error instanceof UnrepresentableReasoningError) || modelBinding) throw error
    console.warn(`[Agent] Delegation reasoning snapshot unavailable for engine=${engineId}; ordinary delegation uses engine defaults: ${error.message}`)
    return { selection: { ...selection }, engineId, reasoningLevel }
  }
  return { selection: { ...selection }, engineId, reasoning, reasoningLevel: reasoningLevel ?? delegatedReasoningLevel(reasoning),
    ...(modelBinding ? { modelBinding: { ...modelBinding, reasoning } } : {}) }
}
