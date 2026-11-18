import { MODEL_SELECTION_LIMITS } from '@hello-halo/agent-sdk/collaboration/protocol'
import { reasoningEffortProfileById } from './constants/reasoning-effort-profiles'
import { isReasoningEffortLevel } from './constants/reasoning-effort'
import type { AISourcesConfig } from './types/ai-sources'
import type { SubagentModelProfile, SubagentModelSettings, SubagentModelSlot, SubagentModelTarget } from './types/subagent-models'

export { MODEL_SELECTION_LIMITS }
export const SUBAGENT_MODEL_SLOTS: readonly SubagentModelSlot[] = ['small', 'medium', 'large']
export const SUBAGENT_MODEL_BUILTIN_NAMES = { small: 'Small', medium: 'Medium', large: 'Large' } as const
const descriptions = { small: 'Clear, simple tasks with easy-to-check results', medium: 'Everyday analysis, implementation, and testing', large: 'Complex reasoning and important reviews' }

export function builtinSubagentModelId(slot: SubagentModelSlot): string { return `builtin:${slot}` }
export function emptySubagentModelSettings(): SubagentModelSettings {
  return { version: 1, revision: 0, policyRevision: 0, selectionMode: 'inherit', profiles: [] }
}
export function projectSubagentModelSettings(settings?: SubagentModelSettings): SubagentModelSettings {
  const current = settings ?? emptySubagentModelSettings()
  return { ...current, profiles: [
    ...SUBAGENT_MODEL_SLOTS.map(slot => current.profiles.find(profile => profile.kind === 'builtin' && profile.slot === slot)
      ?? { id: builtinSubagentModelId(slot), revision: 0, kind: 'builtin' as const, slot, description: descriptions[slot] }),
    ...current.profiles.filter(profile => profile.kind === 'custom'),
  ] }
}
export function subagentModelName(profile: SubagentModelProfile): string {
  return profile.kind === 'custom' ? profile.name : SUBAGENT_MODEL_BUILTIN_NAMES[profile.slot]
}
export function normalizeSubagentModelName(name: string): string { return name.normalize('NFKC').trim().toLocaleLowerCase('en-US') }
export function validSubagentModelText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && [...value].length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
}
export function isSubagentModelTarget(value: unknown): value is SubagentModelTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const validId = (id: unknown) => typeof id === 'string' && id.trim().length > 0 && id.length <= 1024
  return item.kind === 'model'
    ? Object.keys(item).every(key => ['kind', 'sourceId', 'modelId'].includes(key)) && validId(item.sourceId) && validId(item.modelId)
    : item.kind === 'group' && Object.keys(item).every(key => ['kind', 'groupId'].includes(key)) && validId(item.groupId)
}

/** Known model capabilities only; engine restrictions are checked again at execution. */
export function getSubagentModelTargetEfforts(target: SubagentModelTarget, config: AISourcesConfig): readonly string[] {
  if (target.kind === 'group') {
    const members = config.groups?.find(group => group.id === target.groupId)?.members ?? []
    if (!members.length) return []
    return members.map(member => getSubagentModelTargetEfforts({ kind: 'model', ...member }, config))
      .reduce((common, values) => common.filter(value => values.includes(value)))
  }
  const source = config.sources.find(item => item.id === target.sourceId)
  if (!source) return []
  const reported = source.modelCatalogCache?.entries.find(entry => entry.slug === target.modelId)?.supported_reasoning_levels
  if (reported) return reported
  const profile = reasoningEffortProfileById(target.modelId)
  if (!profile?.levels) return []
  const canDisable = !!profile.anthropic || profile.thinkingToggle === true
    || (profile.disableValue !== undefined && !isReasoningEffortLevel(profile.disableValue))
  return [...(canDisable ? ['off'] : []), ...profile.levels.filter(level => level !== 'off')]
}
