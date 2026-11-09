/**
 * Load-balancing group RPC contract (passthrough). Changing a group, and
 * asking how its models stand. Handlers build their own `{ success, data |
 * error }` envelopes; a rejected change also carries `code` (and the position
 * of the offending model) so a client can word it in its own language.
 */
import { rawRpcMethod, type RpcResponse } from '../define'
import type { AIGroup, AISourcesConfig } from '../../types/ai-sources'
import type { GroupHealth, GroupRouteInfo } from '../../types/ai-groups-runtime'

/** What a client sends to create or edit a group. */
export interface AIGroupInput {
  name: string
  strategy?: AIGroup['strategy']
  members: AIGroup['members']
}

export interface AIGroupChange {
  aiSources: AISourcesConfig
  groupId: string
}

export type AIGroupResponse<T = unknown> = RpcResponse<T> & {
  /** A `GroupIssueCode` or `'not-found'` for a rejected change; other codes come from the transport. */
  code?: string
  memberIndex?: number
}

export const aiGroupsRpc = {
  aiGroupsCreate: rawRpcMethod<[input: AIGroupInput], AIGroupResponse<AIGroupChange>>('ai-groups:create'),
  aiGroupsUpdate: rawRpcMethod<[groupId: string, input: AIGroupInput], AIGroupResponse<AIGroupChange>>('ai-groups:update'),
  aiGroupsDelete: rawRpcMethod<[groupId: string], AIGroupResponse<{ aiSources: AISourcesConfig }>>('ai-groups:delete'),
  /** How the models of a group stand now. */
  aiGroupsHealth: rawRpcMethod<[groupId: string], AIGroupResponse<GroupHealth>>('ai-groups:health'),
  /** "Try again now" for one model (`memberKey`) or every model of the group. */
  aiGroupsReleaseRest: rawRpcMethod<[groupId: string, memberKey?: string], AIGroupResponse<{ released: number }>>('ai-groups:release-rest'),
  /** The model each given conversation is on, for those the router has served. */
  aiGroupsRoutes: rawRpcMethod<[sessionKeys: string[]], AIGroupResponse<GroupRouteInfo[]>>('ai-groups:routes'),
}
