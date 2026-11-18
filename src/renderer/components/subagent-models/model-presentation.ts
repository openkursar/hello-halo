import { getSourceAccountName, type AISourcesConfig } from '../../../shared/types/ai-sources'
import type { SubagentModelProfile, SubagentModelTarget } from '../../../shared/types/subagent-models'
import { findSubagentSourceModel, hasUsableSubagentGroup, SUBAGENT_MODEL_BUILTIN_NAMES, SUBAGENT_MODEL_DEFAULT_PURPOSES } from '../../../shared/subagent-models'

type Translate = (text: string) => string

export function profileName(profile: SubagentModelProfile): string {
  return profile.kind === 'custom' ? profile.name : SUBAGENT_MODEL_BUILTIN_NAMES[profile.slot]
}

export function targetLabel(target: SubagentModelTarget | undefined, config: AISourcesConfig, t: Translate): string {
  if (!target) return t('Not configured')
  if (target.kind === 'group') {
    const group = config.groups?.find(item => item.id === target.groupId)
    if (!group) return t('Unavailable group')
    return hasUsableSubagentGroup(group, config.sources) ? group.name : `${group.name} · ${t('Unavailable group')}`
  }
  const source = config.sources.find(item => item.id === target.sourceId)
  if (!source) return t('Unavailable account')
  const model = findSubagentSourceModel(source, target.modelId)
  const account = getSourceAccountName(source)
  const label = model?.name || source.availableModels?.find(item => item.id === target.modelId)?.name
    || source.withdrawnModels?.find(item => item.id === target.modelId)?.name || target.modelId
  return `${source.name || source.provider}${account ? ` · ${account}` : ''} / ${label}${!model ? ` · ${t('Unavailable model')}` : ''}`
}

export function profilePurpose(profile: SubagentModelProfile, t: Translate): string {
  if (profile.kind === 'custom' || profile.description !== SUBAGENT_MODEL_DEFAULT_PURPOSES[profile.slot]) return profile.description
  switch (profile.slot) {
    case 'small': return t('Good at straightforward tasks with clear instructions and easy-to-check results, such as extracting fields, formatting text, or running a focused check.')
    case 'medium': return t('Good at everyday work that needs some judgment, such as comparing options, implementing a well-scoped change, or writing and running tests.')
    case 'large': return t('Good at complex or high-stakes work that needs careful reasoning, such as diagnosing subtle failures, weighing design trade-offs, or reviewing consequential changes.')
  }
}

export function targetKey(target: SubagentModelTarget): string {
  return target.kind === 'group' ? JSON.stringify(['group', target.groupId]) : JSON.stringify(['model', target.sourceId, target.modelId])
}
