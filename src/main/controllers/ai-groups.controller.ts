/**
 * AI Groups Controller - the group operations as transports answer them.
 *
 * IPC and HTTP serve the same operations with the same envelopes, so both call
 * these instead of each wrapping the group service. Every answer carries the
 * configuration with credentials masked, like the other AI source operations.
 */

import { maskOAuthFields } from '../foundation/config-encryption'
import { emitConfigChange } from '../services/health'
import {
  GroupError,
  createGroup,
  deleteGroup,
  getGroupRoutes,
  getHealthOfGroup,
  releaseGroupRest,
  updateGroup,
} from '../services/ai-sources'
import type { AIGroupChange, AIGroupResponse, AIGroupInput } from '../../shared/rpc/contracts/ai-groups.contract'
import type { AISourcesConfig } from '../../shared/types'
import type { GroupHealth, GroupRouteInfo } from '../../shared/types/ai-groups-runtime'
import { notSavedWhileConfigUnreadable } from './config.controller'

function masked(aiSources: AISourcesConfig): AISourcesConfig {
  return maskOAuthFields({ aiSources } as unknown as Record<string, unknown>).aiSources as AISourcesConfig
}

function failed(error: unknown): AIGroupResponse<never> {
  if (error instanceof GroupError) {
    return { success: false, error: error.message, code: error.code, ...(error.memberIndex !== undefined ? { memberIndex: error.memberIndex } : {}) }
  }
  const message = error instanceof Error ? error.message : String(error)
  console.error('[AIGroups] Operation failed:', message)
  return { success: false, error: message }
}

function settle<T>(run: () => T): AIGroupResponse<T> {
  try {
    const data = run()
    return (notSavedWhileConfigUnreadable() as AIGroupResponse<T> | null) ?? { success: true, data }
  } catch (error) {
    return failed(error)
  }
}

export function createGroupAnswer(input: AIGroupInput): AIGroupResponse<AIGroupChange> {
  return settle(() => {
    const { aiSources, group } = createGroup(input)
    emitConfigChange(['aiSources.groups'])
    return { aiSources: masked(aiSources), groupId: group.id }
  })
}

export function updateGroupAnswer(groupId: string, input: AIGroupInput): AIGroupResponse<AIGroupChange> {
  return settle(() => {
    const { aiSources, group } = updateGroup(groupId, input)
    emitConfigChange(['aiSources.groups'])
    return { aiSources: masked(aiSources), groupId: group.id }
  })
}

export function deleteGroupAnswer(groupId: string): AIGroupResponse<{ aiSources: AISourcesConfig }> {
  return settle(() => {
    const { aiSources } = deleteGroup(groupId)
    emitConfigChange(['aiSources.groups'])
    return { aiSources: masked(aiSources) }
  })
}

export function groupHealthAnswer(groupId: string): AIGroupResponse<GroupHealth> {
  const health = getHealthOfGroup(groupId)
  return health ? { success: true, data: health } : failed(new GroupError('not-found'))
}

export function releaseGroupRestAnswer(groupId: string, memberKey?: unknown): AIGroupResponse<{ released: number }> {
  const key = typeof memberKey === 'string' && memberKey.length > 0 && memberKey.length <= 1024 ? memberKey : undefined
  return { success: true, data: { released: releaseGroupRest(groupId, key) } }
}

export function groupRoutesAnswer(sessionKeys: unknown): AIGroupResponse<GroupRouteInfo[]> {
  const keys = Array.isArray(sessionKeys) ? sessionKeys.filter((key): key is string => typeof key === 'string').slice(0, 64) : []
  return { success: true, data: getGroupRoutes(keys) }
}
