import type { ModelProfileCatalog, ModelProfileEntry } from '@hello-halo/agent-sdk/collaboration'
import { getEngineSourceCompatibility } from '../../../shared/engine-source'
import { isSourceGroupEligible } from '../../../shared/ai-groups'
import { getSubagentModelTargetEfforts } from '../../../shared/subagent-models'
import type { AIGroup, AISource, AISourcesConfig } from '../../../shared/types/ai-sources'
import type { SubagentModelSettings } from '../../../shared/types/subagent-models'
import type { EngineId } from '../../../shared/types/engine'

const builtinNames = { small: 'Small (小杯)', medium: 'Medium (中杯)', large: 'Large (大杯)' }

function accountLabel(source: AISource): string | undefined {
  const name = source.name.trim()
  if (!name || [...name].length > 80 || /[@\u0000-\u001f]|:\/\//u.test(name)) return undefined
  return name
}

function sourceIssue(source: AISource | undefined, modelId: string, engineId: EngineId): string | undefined {
  if (!source) return 'The configured model account was removed.'
  if (source.authType !== 'delegated' && !(source.authType === 'api-key' ? source.apiKey : source.accessToken)) {
    return 'The configured model account is not signed in or configured.'
  }
  if (source.withdrawnModels?.some(model => model.id === modelId)) return 'The account no longer offers the configured model.'
  const compatibility = getEngineSourceCompatibility(engineId, source)
  return compatibility.compatible ? undefined : compatibility.message
}

function configuredDefault(source: AISource, modelId: string): string | undefined {
  const value = source.modelOverrides?.[modelId]?.reasoningEffort
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** A projection of one captured configuration, with no credential refresh or discovery. */
export function buildSubagentModelCatalog(input: {
  settings: SubagentModelSettings
  sources: readonly AISource[]
  groups: readonly AIGroup[]
  engineId: EngineId
  revision: string
}): ModelProfileCatalog {
  const sourceById = new Map(input.sources.map(source => [source.id, source]))
  const groupById = new Map(input.groups.map(group => [group.id, group]))
  const config: AISourcesConfig = { version: 2, currentId: '', sources: [...input.sources], groups: [...input.groups] }
  const profiles: ModelProfileEntry[] = []
  for (const profile of input.settings.profiles) {
    const target = profile.target
    if (!target) continue
    let issue: string | undefined
    let label: string
    let models: string[]
    let account: string | undefined
    let modelDefault: string | undefined
    if (target.kind === 'model') {
      const source = sourceById.get(target.sourceId)
      issue = sourceIssue(source, target.modelId, input.engineId)
      label = source?.availableModels?.find(model => model.id === target.modelId)?.name || target.modelId
      models = [target.modelId]
      if (source) {
        account = accountLabel(source)
        modelDefault = configuredDefault(source, target.modelId)
      }
    } else {
      const group = groupById.get(target.groupId)
      const compatibility = getEngineSourceCompatibility(input.engineId, { isGroup: true })
      const usable = group?.members.flatMap(member => {
        const source = sourceById.get(member.sourceId)
        return source && isSourceGroupEligible(source) ? [{ source, modelId: member.modelId }] : []
      }) ?? []
      issue = !group ? 'The configured load-balancing group was removed.'
        : !compatibility.compatible ? compatibility.message
          : !usable.length ? 'The configured load-balancing group has no usable model account.' : undefined
      label = group?.name || 'Unavailable load-balancing group'
      models = group?.members.map(member => member.modelId) ?? []
      const defaults = usable.map(member => configuredDefault(member.source, member.modelId))
      if (defaults.length && defaults[0] && defaults.every(value => value === defaults[0])) modelDefault = defaults[0]
    }
    const supported = getSubagentModelTargetEfforts(target, config)
    if (!issue && profile.reasoningEffort && !supported.includes(profile.reasoningEffort)) {
      issue = 'The configured reasoning effort is no longer supported by this target.'
    }
    profiles.push({
      profileId: profile.id,
      profileRevision: String(profile.revision),
      name: profile.kind === 'builtin' ? builtinNames[profile.slot] : profile.name,
      description: profile.description,
      target: { kind: target.kind === 'group' ? 'pool' : 'single', label, models,
        ...(account ? { accountLabel: account } : {}) },
      reasoning: {
        ...(supported.length ? { supported } : {}),
        ...(profile.reasoningEffort ? { profileDefault: profile.reasoningEffort } : {}),
        ...(modelDefault ? { modelDefault } : {}),
      },
      available: !issue,
      ...(issue ? { unavailableReason: issue } : {}),
    })
  }
  return { revision: input.revision, policy: input.settings.selectionMode,
    policyRevision: String(input.settings.policyRevision), profiles }
}
