/**
 * What the router is told about a group on every request that names one: members
 * in priority order with names a person recognizes, and each member's backend
 * config built on demand, so a credential is fetched only for models actually
 * tried. It reads no configuration itself; everything comes through its dependencies.
 */

import type { GroupPlan, GroupMemberPlan } from '../../openai-compat-router'
import { describeGroupMember, groupMemberKey } from '../../../shared/ai-groups'
import { isAnthropicProvider } from '../../../shared/constants'
import {
  resolveModelId,
  type AIGroup,
  type AISource,
  type BackendRequestConfig,
} from '../../../shared/types/ai-sources'

/** Every request asks, so ids that are no group (an ordinary account's) are remembered too; the oldest go first. */
const MAX_CACHED_PLANS = 64

export interface GroupPlanDeps {
  /** Memory-only; saved configuration replaces the snapshot and invalidates plans. */
  readGroup(groupId: string): AIGroup | null
  /** The accounts in that snapshot: names and settings are read from them, never a secret. */
  readSources(): readonly AISource[]
  /** The account's backend config for a model with a current credential; rejects when it cannot serve. */
  backendFor(sourceId: string, modelId: string): Promise<BackendRequestConfig>
}

export interface GroupPlanResolver {
  resolve(groupId: string): GroupPlan | null
  /** Drop remembered plans: a group or an account changed. */
  invalidate(): void
}

/**
 * A member's config in the form the router needs behind a group.
 *
 * An engine that talks to an account directly lets the vendor's SDK compose
 * the Anthropic endpoint and infer the wire protocol; behind a group the router
 * must be told both, exactly as it is for a single account.
 */
export function toRouterBackend(source: AISource, backend: BackendRequestConfig, modelId: string): BackendRequestConfig {
  const config: BackendRequestConfig = { ...backend, sourceId: source.id }
  const reasoningEffort = source.modelOverrides?.[modelId]?.reasoningEffort
  if (reasoningEffort !== undefined) config.reasoningEffort = reasoningEffort

  if (source.authType === 'api-key' && isAnthropicProvider(source.provider)) {
    config.url = `${backend.url.replace(/\/+$/, '')}/v1/messages`
    config.apiType = 'anthropic_passthrough'
  } else if (!config.apiType && source.authType === 'oauth') {
    config.apiType = 'chat_completions'
  }

  // The same retired-id rule a single account follows on the Anthropic wire.
  if (config.apiType !== 'chat_completions' && config.apiType !== 'responses' && config.model) {
    config.model = resolveModelId(config.model)
  }
  return config
}

export function createGroupPlanResolver(deps: GroupPlanDeps): GroupPlanResolver {
  const cache = new Map<string, GroupPlan | null>()

  function build(groupId: string): GroupPlan | null {
    const group = deps.readGroup(groupId)
    if (!group) return null
    // One read of the accounts serves the labels and every member's config until the plan is rebuilt.
    const sources = deps.readSources()
    const members: GroupMemberPlan[] = group.members.map(member => ({
      member: { key: groupMemberKey(member), sourceId: member.sourceId, modelId: member.modelId },
      label: describeGroupMember(sources.find(source => source.id === member.sourceId), member.modelId),
    }))
    return {
      id: group.id,
      name: group.name,
      strategy: group.strategy,
      members,
      async materialize(member) {
        const backend = await deps.backendFor(member.sourceId, member.modelId)
        const source = sources.find(item => item.id === member.sourceId)
        if (!source) throw new Error('This account was removed.')
        return toRouterBackend(source, backend, member.modelId)
      },
    }
  }

  return {
    resolve(groupId) {
      if (cache.has(groupId)) return cache.get(groupId) ?? null
      const plan = build(groupId)
      if (cache.size >= MAX_CACHED_PLANS) cache.delete(cache.keys().next().value as string)
      cache.set(groupId, plan)
      return plan
    },
    invalidate() {
      cache.clear()
    },
  }
}
