/**
 * aiGroupsApi — load-balancing group slice of the unified api object.
 * Same operations over IPC (desktop) and HTTP (remote).
 */
import { httpRequest, isElectron } from './_shared'
import type { ApiResponse } from './_shared'
import { reportIfNotSaved } from './config.api'
import type { AIGroupChange, AIGroupInput } from '../../shared/rpc/contracts/ai-groups.contract'
import type { AISourcesConfig } from '../../shared/types'
import type { GroupHealth, GroupRouteInfo } from '../../shared/types/ai-groups-runtime'

/** A rejected change names the model it is about, so the editor can point at it. */
export type GroupApiResponse<T = unknown> = ApiResponse<T> & { memberIndex?: number }

export const aiGroupsApi = {
  aiGroupsCreate: async (input: AIGroupInput): Promise<GroupApiResponse<AIGroupChange>> => {
    const response = isElectron()
      ? await window.halo.aiGroupsCreate(input)
      : await httpRequest('POST', '/api/ai-groups', input as unknown as Record<string, unknown>)
    return reportIfNotSaved(response) as GroupApiResponse<AIGroupChange>
  },

  aiGroupsUpdate: async (groupId: string, input: AIGroupInput): Promise<GroupApiResponse<AIGroupChange>> => {
    const response = isElectron()
      ? await window.halo.aiGroupsUpdate(groupId, input)
      : await httpRequest('PUT', `/api/ai-groups/${encodeURIComponent(groupId)}`, input as unknown as Record<string, unknown>)
    return reportIfNotSaved(response) as GroupApiResponse<AIGroupChange>
  },

  aiGroupsDelete: async (groupId: string): Promise<GroupApiResponse<{ aiSources: AISourcesConfig }>> => {
    const response = isElectron()
      ? await window.halo.aiGroupsDelete(groupId)
      : await httpRequest('DELETE', `/api/ai-groups/${encodeURIComponent(groupId)}`)
    return reportIfNotSaved(response) as GroupApiResponse<{ aiSources: AISourcesConfig }>
  },

  /** How the models of a group stand now. */
  aiGroupsHealth: async (groupId: string): Promise<GroupApiResponse<GroupHealth>> => {
    if (isElectron()) return window.halo.aiGroupsHealth(groupId)
    return httpRequest('GET', `/api/ai-groups/${encodeURIComponent(groupId)}/health`)
  },

  /** "Try again now" for one model (`memberKey`) or every model of the group. */
  aiGroupsReleaseRest: async (groupId: string, memberKey?: string): Promise<GroupApiResponse<{ released: number }>> => {
    if (isElectron()) return window.halo.aiGroupsReleaseRest(groupId, memberKey)
    return httpRequest('POST', `/api/ai-groups/${encodeURIComponent(groupId)}/release-rest`, memberKey ? { memberKey } : {})
  },

  /** The model each given conversation is on, for those a group has served. */
  aiGroupsRoutes: async (sessionKeys: string[]): Promise<GroupApiResponse<GroupRouteInfo[]>> => {
    if (isElectron()) return window.halo.aiGroupsRoutes(sessionKeys)
    return httpRequest('POST', '/api/ai-groups/routes', { sessionKeys })
  },
}
