/**
 * Task State IPC Handlers
 */

import {
  listTaskState,
  markTaskUnseen,
  markTaskRead,
  setTaskKept,
  removeTaskState
} from '../controllers/task.controller'
import { taskRpc } from '../../shared/rpc/contracts/task.contract'
import { registerRawRpcHandlers } from './rpc'

export function registerTaskHandlers(): void {
  registerRawRpcHandlers(taskRpc, {
    taskListState: async () => listTaskState(),

    taskMarkUnseen: async (conversationId: string, spaceId: string, title: string) =>
      markTaskUnseen(conversationId, spaceId, title),

    taskMarkRead: async (
      conversationId: string,
      spaceId: string,
      title: string,
      originalStatus: 'completed-unseen' | 'error'
    ) => markTaskRead(conversationId, spaceId, title, originalStatus),

    taskSetKept: async (conversationId: string, kept: boolean) => setTaskKept(conversationId, kept),

    taskRemoveState: async (conversationId: string) => removeTaskState(conversationId),
  })
}
