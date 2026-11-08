/**
 * Load-balancing group IPC handlers.
 */

import { aiGroupsRpc } from '../../shared/rpc/contracts/ai-groups.contract'
import {
  createGroupAnswer,
  deleteGroupAnswer,
  groupHealthAnswer,
  groupRoutesAnswer,
  releaseGroupRestAnswer,
  updateGroupAnswer,
} from '../controllers/ai-groups.controller'
import { registerRawRpcHandlers } from './rpc'

export function registerAiGroupsHandlers(): void {
  registerRawRpcHandlers(aiGroupsRpc, {
    aiGroupsCreate: async input => createGroupAnswer(input),
    aiGroupsUpdate: async (groupId, input) => updateGroupAnswer(groupId, input),
    aiGroupsDelete: async groupId => deleteGroupAnswer(groupId),
    aiGroupsHealth: async groupId => groupHealthAnswer(groupId),
    aiGroupsReleaseRest: async (groupId, memberKey) => releaseGroupRestAnswer(groupId, memberKey),
    aiGroupsRoutes: async sessionKeys => groupRoutesAnswer(sessionKeys),
  })
  console.log('[AIGroups] IPC handlers registered')
}
