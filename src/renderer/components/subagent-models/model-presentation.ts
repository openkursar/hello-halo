import { listSourceModels } from '../../../shared/ai-groups'
import { getSourceAccountName, type AISourcesConfig } from '../../../shared/types/ai-sources'
import type { SubagentModelProfile, SubagentModelTarget } from '../../../shared/types/subagent-models'

type Translate = (text: string) => string

export function profileName(profile: SubagentModelProfile, t: Translate): string {
  if (profile.kind === 'custom') return profile.name
  return { small: t('Small · Lightweight'), medium: t('Medium · Balanced'), large: t('Large · High capability') }[profile.slot]
}

export function targetLabel(target: SubagentModelTarget | undefined, config: AISourcesConfig, t: Translate): string {
  if (!target) return t('Not configured')
  if (target.kind === 'group') return config.groups?.find(group => group.id === target.groupId)?.name ?? t('Unavailable group')
  const source = config.sources.find(item => item.id === target.sourceId)
  if (!source) return t('Unavailable account')
  const model = listSourceModels(source).find(item => item.id === target.modelId)
  const account = getSourceAccountName(source)
  return `${source.name || source.provider}${account ? ` · ${account}` : ''} / ${model?.name || target.modelId}${!model ? ` · ${t('Unavailable model')}` : ''}`
}

export function defaultPurpose(slot: 'small' | 'medium' | 'large', t: Translate): string {
  return { small: t('Clear, simple tasks with easy-to-check results'), medium: t('Everyday analysis, implementation, and testing'), large: t('Complex reasoning and important reviews') }[slot]
}

export function profilePurpose(profile: SubagentModelProfile, t: Translate): string {
  if (profile.kind === 'custom') return profile.description
  const defaults = { small: 'Clear, simple tasks with easy-to-check results', medium: 'Everyday analysis, implementation, and testing', large: 'Complex reasoning and important reviews' }
  return profile.description === defaults[profile.slot] || profile.revision === 0 ? defaultPurpose(profile.slot, t) : profile.description
}

export function targetKey(target: SubagentModelTarget): string {
  return target.kind === 'group' ? JSON.stringify(['group', target.groupId]) : JSON.stringify(['model', target.sourceId, target.modelId])
}
