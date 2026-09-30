/**
 * Cross-Conversation Interop — native conversation busyness.
 *
 * A native conversation's session key is its own conversation id
 * (session-manager.ts), so busyness is the engine's own `isSessionBusy`:
 * a turn in flight, or — idle between turns — team agents still working that a
 * future turn must not be torn down under.
 *
 * `session-manager.ts` itself imports FROM `toolsets/broker.ts` (session
 * creation seeds its MCP servers via `buildCreationTimeServers`). A static
 * import here would be safe only as long as `broker.ts` never statically
 * imports this module back — see `toolsets/broker.ts`'s dependency-inversion
 * seam (`setConversationInteropFactory`), which exists specifically so that
 * loop never closes.
 */

import { isSessionBusy, v2Sessions } from '../agent'

export function isNativeConversationBusy(conversationId: string): boolean {
  return isSessionBusy(conversationId)
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
