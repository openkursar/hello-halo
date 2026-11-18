import { MODEL_SELECTION_LIMITS } from '@hello-halo/agent-sdk/collaboration/protocol'
import { isSourceGroupEligible, listSourceModels } from './ai-groups'
import { forcedThinkingLevel, reasoningEffortProfileById } from './constants/reasoning-effort-profiles'
import { REASONING_EFFORT_LEVELS, type ReasoningEffortLevel } from './constants/reasoning-effort'
import { isSourceConfigured, type AIGroup, type AISource, type ModelOption } from './types/ai-sources'
import type { SubagentModelProfile, SubagentModelSettings, SubagentModelSlot, SubagentModelTarget } from './types/subagent-models'

export { MODEL_SELECTION_LIMITS }
export const SUBAGENT_MODEL_SLOTS: readonly SubagentModelSlot[] = ['small', 'medium', 'large']
export const SUBAGENT_MODEL_BUILTIN_NAMES = { small: 'Small', medium: 'Medium', large: 'Large' } as const
export const SUBAGENT_MODEL_DEFAULT_PURPOSES = {
  small: 'Good at straightforward tasks with clear instructions and easy-to-check results, such as extracting fields, formatting text, or running a focused check.',
  medium: 'Good at everyday work that needs some judgment, such as comparing options, implementing a well-scoped change, or writing and running tests.',
  large: 'Good at complex or high-stakes work that needs careful reasoning, such as diagnosing subtle failures, weighing design trade-offs, or reviewing consequential changes.',
} as const

export function builtinSubagentModelId(slot: SubagentModelSlot): string { return `builtin:${slot}` }
export function emptySubagentModelSettings(): SubagentModelSettings {
  return { version: 1, revision: 0, policyRevision: 0, selectionMode: 'inherit', profiles: [] }
}
export function projectSubagentModelSettings(settings?: SubagentModelSettings): SubagentModelSettings {
  const current = settings ?? emptySubagentModelSettings()
  const profiles: SubagentModelProfile[] = [
    ...SUBAGENT_MODEL_SLOTS.map(slot => current.profiles.find(profile => profile.kind === 'builtin' && profile.slot === slot)
      ?? { id: builtinSubagentModelId(slot), revision: 0, kind: 'builtin' as const, slot, description: SUBAGENT_MODEL_DEFAULT_PURPOSES[slot] }),
    ...current.profiles.filter(profile => profile.kind === 'custom'),
  ]
  return { ...current, profiles: profiles.map(profile => {
    if (!('reasoningEffort' in profile)) return profile
    const { reasoningEffort: _legacyEffort, ...assignment } = profile
    return assignment
  }) }
}
export function subagentModelName(profile: SubagentModelProfile): string {
  return profile.kind === 'custom' ? profile.name : SUBAGENT_MODEL_BUILTIN_NAMES[profile.slot]
}
export function normalizeSubagentModelName(name: string): string { return name.normalize('NFKC').trim().toLocaleLowerCase('en-US') }
export function validSubagentModelText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && [...value].length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
}
function validTargetId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 1024 && id.trim().length > 0
}

export function isSubagentModelTarget(value: unknown): value is SubagentModelTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.kind === 'model'
    ? Object.keys(item).every(key => ['kind', 'sourceId', 'modelId'].includes(key)) && validTargetId(item.sourceId) && validTargetId(item.modelId)
    : item.kind === 'group' && Object.keys(item).every(key => ['kind', 'groupId'].includes(key)) && validTargetId(item.groupId)
}

function canChooseSource(source: AISource): boolean {
  return validTargetId(source.id) && (source.authType === 'delegated' || isSourceConfigured(source))
}

/** The model choices an assignment can currently offer for this account. */
export function listSubagentSourceModels(source: AISource): ModelOption[] {
  if (!canChooseSource(source)) return []
  const withdrawn = source.withdrawnModels?.length ? new Set(source.withdrawnModels.map(model => model.id)) : undefined
  return listSourceModels(source).filter(model => validTargetId(model.id) && !withdrawn?.has(model.id))
}

/** Check one offered choice without allocating the complete list. */
export function findSubagentSourceModel(source: AISource, modelId: string): ModelOption | undefined {
  if (!canChooseSource(source) || !validTargetId(modelId) || source.withdrawnModels?.some(model => model.id === modelId)) return undefined
  return listSourceModels(source).find(model => model.id === modelId)
}

/** At least one configured member has not been explicitly withdrawn. */
export function hasUsableSubagentGroup(group: AIGroup, sources: readonly AISource[]): boolean {
  return validTargetId(group.id) && group.members.some(member => {
    const source = sources.find(item => item.id === member.sourceId)
    return source && isSourceGroupEligible(source) && !source.withdrawnModels?.some(model => model.id === member.modelId)
  })
}

/** Known model capabilities only; engine restrictions are checked again at execution. */
export function getSubagentSourceModelEfforts(source: AISource, modelId: string): readonly ReasoningEffortLevel[] {
  const reported = source.modelCatalogCache?.entries.find(entry => entry.slug === modelId)?.supported_reasoning_levels
  const profile = reasoningEffortProfileById(modelId)
  const canDisable = !forcedThinkingLevel(profile) && Boolean(profile.anthropic || profile.thinkingToggle || profile.disableValue)
    && (!reported || !profile.disableValue || reported.includes(profile.disableValue))
  return REASONING_EFFORT_LEVELS.filter(level => level === 'off' ? canDisable
    : (profile.levels?.includes(level) ?? !!reported) && (!reported || reported.includes(level)))
}
