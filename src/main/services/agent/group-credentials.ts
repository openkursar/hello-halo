/**
 * Credentials for a session on a load-balancing group: one stable model whose
 * limits are what every usable member can do. The placeholder endpoint and key are
 * never sent; the router recognizes the group by id and supplies each member's own.
 */

import { isSourceGroupEligible } from '../../../shared/ai-groups'
import { resolveModelVision } from '../../../shared/constants'
import { GROUP_MODEL_ID, type AIGroup, type AISource } from '../../../shared/types/ai-sources'
import type { ApiCredentials, ResolvedModelCapabilities } from './types'

const GROUP_ENDPOINT = 'https://halo-group.invalid/v1/chat/completions'
const GROUP_KEY = 'halo-group'

export interface GroupCredentialDeps {
  readSource(sourceId: string): AISource | null
  capabilitiesOf(source: AISource, modelId: string): ResolvedModelCapabilities
  credentialsGeneration(groupId: string): number | string
}

export function resolveGroupCredentials(group: AIGroup, deps: GroupCredentialDeps): ApiCredentials {
  const usable = group.members.flatMap(member => {
    const source = deps.readSource(member.sourceId)
    return source && isSourceGroupEligible(source) ? [{ source, modelId: member.modelId }] : []
  })
  if (usable.length === 0) {
    console.warn(`[AgentService] Credential resolution refused: group ${group.id} has no usable model`)
    throw new Error(`None of the models in "${group.name}" can be used. Add a model to the group or sign in to its accounts again.`)
  }

  const capabilities = usable.map(({ source, modelId }) => deps.capabilitiesOf(source, modelId))
  const vision = usable.every(({ source, modelId }) => resolveModelVision(source, modelId))
  return {
    sourceId: group.id,
    credentialsGeneration: deps.credentialsGeneration(group.id),
    baseUrl: GROUP_ENDPOINT,
    apiKey: GROUP_KEY,
    model: GROUP_MODEL_ID,
    displayModel: group.name,
    provider: 'openai',
    apiType: 'chat_completions',
    isGroup: true,
    visionOverride: vision,
    supportsVision: vision,
    capabilities: {
      maxOutputTokens: Math.min(...capabilities.map(item => item.maxOutputTokens)),
      contextWindow: Math.min(...capabilities.map(item => item.contextWindow)),
      adaptiveThinking: capabilities.every(item => item.adaptiveThinking === true),
    },
  }
}
