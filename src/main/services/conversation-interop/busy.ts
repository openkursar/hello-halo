/**
 * Cross-Conversation Interop — native conversation busyness.
 *
 * A native conversation's session key is its own conversation id
 * (session-manager.ts). `session-manager`'s own busyness check
 * (`isSessionBusy`) is private, but every primitive it composes is already
 * exported, so this reconstructs the identical check from outside
 * `services/agent` rather than adding a new export to it: a session is busy
 * if a legacy `activeSessions` entry is live, or its consumer is running a
 * turn right now, or — idle between turns — it still has team agents working
 * that a future turn must not be torn down under (mirrors session-manager's
 * own idle-timeout guard).
 *
 * `session-manager.ts` itself imports FROM `toolsets/broker.ts` (session
 * creation seeds its MCP servers via `buildCreationTimeServers`). A static
 * import here would be safe only as long as `broker.ts` never statically
 * imports this module back — see `toolsets/broker.ts`'s dependency-inversion
 * seam (`setConversationInteropFactory`), which exists specifically so that
 * loop never closes.
 */

import { activeSessions, getConsumerHandle, v2Sessions } from '../agent/session-manager'
import { hasActiveTeamTasks } from '../agent/subagent-handler'

export function isNativeConversationBusy(conversationId: string): boolean {
  if (activeSessions.has(conversationId)) return true
  const consumer = getConsumerHandle(conversationId)
  if (!consumer?.isRunning) return false
  if (consumer.getActiveSessionState()) return true
  return hasActiveTeamTasks(consumer.getTeamLifecycleThoughts())
}

/**
 * Whether the agent layer has ANY live V2 session for this conversation —
 * narrower than `isNativeConversationBusy`: a session can exist and be
 * completely idle between turns. `delivery.ts` uses this to tell a turn that
 * is genuinely still starting (which creates its session early, before
 * `system:init` ever fires) apart from a turn-gate reservation phantom-left
 * -behind by one that crashed before getting that far — a session existing
 * at all, busy or not, rules out the phantom case.
 */
export function hasLiveNativeSession(conversationId: string): boolean {
  return v2Sessions.has(conversationId)
}
