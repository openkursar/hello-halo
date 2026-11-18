import type { EffectiveReasoning, ModelSelectionSnapshot } from '@hello-halo/agent-sdk/collaboration'
import type { AgentModelSelection } from '../../../shared/types/ai-sources'
import type { EngineId } from '../../../shared/types/engine'
import { captureEffectiveReasoning } from './reasoning-effort'
import type { ResolvedModelCapabilities } from './types'

/** The resolved execution behind a delegation, never a pending UI selection. */
export interface DelegatedModelContext {
  selection: AgentModelSelection
  engineId: EngineId
  reasoning: EffectiveReasoning
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
): DelegatedModelContext {
  const reasoning = captureEffectiveReasoning(options, engineId, capabilities)
  return { selection: { ...selection }, engineId, reasoning,
    ...(modelBinding ? { modelBinding: { ...modelBinding, reasoning } } : {}) }
}
