import type { PreparedModelMetadata, EffectiveReasoning } from '@hello-halo/agent-sdk/collaboration'
import { isSourceGroupEligible } from '../../../shared/ai-groups'
import { assertEngineSourceCompatible } from '../../../shared/engine-source'
import type { ReasoningEffortLevel } from '../../../shared/constants/reasoning-effort'
import { forcedThinkingLevel, reasoningEffortProfileById } from '../../../shared/constants/reasoning-effort-profiles'
import type { AgentModelSelection } from '../../../shared/types/ai-sources'
import type { EngineId } from '../../../shared/types/engine'
import { getAISourceManager, getGroup } from '../ai-sources'
import { getApiCredentialsForStrictSelection } from './helpers'
import { applyReasoningEffort, captureEffectiveReasoning } from './reasoning-effort'
import type { ApiCredentials } from './types'

/** Whether pool routes can preserve default routing or a common explicit effort. */
export function describeGroupReasoningCompatibility(models: readonly string[]): { compatible: boolean; reason?: string } {
  const profiles = models.map(model => reasoningEffortProfileById(model))
  return profiles.length > 0 ? { compatible: true } : { compatible: false, reason: 'The target group has no usable models' }
}

/** Prepare only model identity and capabilities; never return executable session options. */
export async function prepareSubagentModelMetadata(
  selection: AgentModelSelection,
  engineId: EngineId
): Promise<{ credentials: ApiCredentials; metadata: PreparedModelMetadata }> {
  const credentials = await getApiCredentialsForStrictSelection(selection)
  assertEngineSourceCompatible(engineId, credentials)
  const capabilities = credentials.capabilities
  if (!capabilities) throw new Error('The target model has no resolved capacity metadata')
  const group = credentials.isGroup ? getGroup(selection.modelSourceId) : undefined
  if (credentials.isGroup && !group) throw new Error('The target group changed during model preparation')
  const manager = getAISourceManager()
  const models = group ? group.members.filter(member => {
    const source = manager.getSourceConfig(member.sourceId)
    return source && isSourceGroupEligible(source)
  }).map(member => member.modelId) : [credentials.model]
  const profiles = models.map(model => reasoningEffortProfileById(model))
  const dshNative = engineId === 'dsh' && (credentials.provider === 'anthropic' || credentials.apiType === 'anthropic_passthrough' || credentials.oauthProvider === 'claude')
  if (group && models.length === 0) throw new Error('The target group has no usable models')
  const declared = profiles.map(profile => profile.levels)
  const supported = declared.every(levels => levels !== undefined)
    ? declared[0]?.filter(level => level !== 'off' && declared.every(levels => levels!.includes(level))) : undefined
  const options: Record<string, unknown> = { model: credentials.model, apiCredentials: credentials }
  if (capabilities.adaptiveThinking) options.adaptiveThinking = true
  applyReasoningEffort(options, true, capabilities)
  const defaultReasoning: EffectiveReasoning = group
    ? capabilities.reasoningEffort ? { version: 1, mode: 'effort', effort: capabilities.reasoningEffort } : { version: 1, mode: 'provider-default' }
    : captureEffectiveReasoning(options, engineId, capabilities)
  const effortMapping: Record<string, EffectiveReasoning> = {}
  for (const effort of supported ?? []) {
    const mapped: Record<string, unknown> = { model: credentials.model, apiCredentials: credentials }
    if (capabilities.adaptiveThinking) mapped.adaptiveThinking = true
    applyReasoningEffort(mapped, true, capabilities, effort as ReasoningEffortLevel)
    const effective: EffectiveReasoning = dshNative && profiles[0]?.anthropic?.mode === 'adaptive'
      ? { version: 1, mode: 'adaptive', effort }
      : group || engineId === 'dsh' ? { version: 1, mode: 'effort', effort } : captureEffectiveReasoning(mapped, engineId, capabilities)
    if ('effort' in effective && effective.effort === effort) effortMapping[effort] = effective
  }
  const supportsOff = profiles.every(profile =>
    !forcedThinkingLevel(profile) && Boolean(profile.anthropic || profile.thinkingToggle || profile.disableValue))
  if (supportsOff) effortMapping.off = { version: 1, mode: 'off' }
  const modes: EffectiveReasoning['mode'][] = ['provider-default']
  if (supportsOff) modes.push('off')
  if (supported?.length) modes.push('effort')
  const nativeThinking = engineId === 'halo' || engineId === 'anthropic'
  const supportsBudget = nativeThinking && !group && profiles[0]?.anthropic?.mode === 'budget'
  const supportsAdaptive = (nativeThinking || dshNative) && !group
    && (capabilities.adaptiveThinking === true || profiles[0]?.anthropic?.mode === 'adaptive')
  if (supportsBudget) modes.push('budget')
  if (supportsAdaptive) modes.push('adaptive')
  const identity = JSON.stringify({ sourceId: selection.modelSourceId, modelId: credentials.model })
  return {
    credentials,
    metadata: {
      bindingId: identity,
      restoreRef: identity,
      model: credentials.model,
      targetKind: credentials.isGroup ? 'pool' : 'single',
      contextWindow: capabilities.contextWindow,
      maxOutputTokens: capabilities.maxOutputTokens,
      modalities: (credentials.visionOverride ?? credentials.supportsVision) ? ['text', 'image'] : ['text'],
      reasoning: {
        default: defaultReasoning,
        modes,
        ...(supportsBudget ? { maxBudgetTokens: capabilities.maxOutputTokens - 1 } : {}),
        ...(supported || supportsOff ? { supported: Object.keys(effortMapping), effortMapping } : {}),
      },
    },
  }
}
