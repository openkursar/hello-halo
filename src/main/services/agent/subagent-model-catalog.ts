import type { ModelProfileCatalog, ModelProfileEntry, ModelProfileQueryResult } from '@hello-halo/agent-sdk/collaboration'
import { subagentModelName } from '../../../shared/subagent-models'
import { getEngineSourceCompatibility } from '../../../shared/engine-source'
import { isSourceGroupEligible } from '../../../shared/ai-groups'
import type { AIGroup, AISource } from '../../../shared/types/ai-sources'
import type { SubagentModelSettings } from '../../../shared/types/subagent-models'
import type { EngineId } from '../../../shared/types/engine'

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
  const profiles: ModelProfileEntry[] = []
  for (const profile of input.settings.profiles) {
    const target = profile.target
    if (!target) continue
    let issue: string | undefined
    let label: string
    let models: string[]
    let account: string | undefined
    if (target.kind === 'model') {
      const source = sourceById.get(target.sourceId)
      issue = sourceIssue(source, target.modelId, input.engineId)
      label = source?.availableModels?.find(model => model.id === target.modelId)?.name || target.modelId
      models = [target.modelId]
      if (source) account = accountLabel(source)
    } else {
      const group = groupById.get(target.groupId)
      const compatibility = getEngineSourceCompatibility(input.engineId, { isGroup: true })
      const usable = group?.members.some(member => {
        const source = sourceById.get(member.sourceId)
        return source && isSourceGroupEligible(source) && !source.withdrawnModels?.some(model => model.id === member.modelId)
      })
      issue = !group ? 'The configured load-balancing group was removed.'
        : !compatibility.compatible ? compatibility.message
          : !usable ? 'The configured load-balancing group has no usable model account.' : undefined
      label = group?.name || 'Unavailable load-balancing group'
      models = group?.members.map(member => member.modelId) ?? []
    }
    profiles.push({
      profileId: profile.id,
      profileRevision: String(profile.revision),
      name: subagentModelName(profile),
      description: profile.description,
      target: { kind: target.kind === 'group' ? 'pool' : 'single', label, models,
        ...(account ? { accountLabel: account } : {}) },
      reasoning: {},
      available: !issue,
      ...(issue ? { unavailableReason: issue } : {}),
    })
  }
  return { revision: input.revision, policy: input.settings.selectionMode,
    policyRevision: String(input.settings.policyRevision), profiles }
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').trim()
}

export function formatSubagentModelDirectory(result: ModelProfileQueryResult, reference: (ref: string) => string): string {
  const entries = result.profiles.map(profile => {
    const { target } = profile
    const name = singleLine(profile.name)
    const description = singleLine(profile.description)
    const label = singleLine(target.label)
    const modelId = singleLine(target.models[0] ?? '')
    const account = target.accountLabel ? ` · Account: ${singleLine(target.accountLabel)}` : ''
    const targetLine = target.kind === 'pool' ? `Load-balancing group: ${label}`
      : `Model: ${label}${label === modelId ? '' : ` (ID: ${modelId})`}${account}`
    const choice = profile.available ? `model_profile: ${reference(profile.selectionRef)}`
      : `Unavailable: ${singleLine(profile.unavailableReason ?? 'The target is not available.')}`
    return `- ${name}${description ? ` — ${description}` : ''}\n  ${targetLine}\n  ${choice}`
  })
  return entries.length ? entries.join('\n\n') : 'No configured model profiles.'
}
