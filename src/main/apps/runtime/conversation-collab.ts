/**
 * apps/runtime -- conversation collaboration gate
 *
 * Whether a digital human's turn gets the `halo-conversations` tools
 * (`conversation_read` / `conversation_send`), and how they are scoped. One
 * decision for every entry that mounts them — interactive chat and scheduled
 * runs — so they cannot drift apart.
 *
 * Three independent conditions must all hold:
 * - the owner switched "conversation collaboration" on for this digital human
 *   (off by default — see `isConversationCollabEnabled`);
 * - the caller is the owner. An IM guest and a teammate's borrowed turn are
 *   somebody else acting through this digital human; the capability policy
 *   never lists these tools, so it withholds them on those turns, and this gate
 *   makes the exclusion hold even where no policy is applied;
 * - the global master switch for conversation interop is not off. Its
 *   send-only sub-switch narrows the tools to reading.
 *
 * Only the sessions the desktop user holds with the digital human — its default
 * session and its local ones — and its scheduled runs get them. An IM or HTTP
 * session is a different counterpart, and replies to its key cannot be routed
 * back (the conversation directory does not list it), so the tools would only
 * ever time out there. A run acts under its own sender key (see
 * `run-conversation-source.ts`): what it sends is a one-way notice.
 *
 * Team-channel turns are not offered them either: a member's collaboration goes
 * through the team's own tools, and its conversation is not one of the
 * space's conversations.
 */

import { isConversationCollabEnabled } from '../../../shared/apps/app-types'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { getConfig } from '../../foundation/config.service'
import { parseNativeChatKey, parseRunSenderKey } from '../../../shared/apps/im-keys'

/** What another conversation's AI is told when it names a digital human that has collaboration switched off. */
export const COLLAB_OFF_REASON = 'this digital human has conversation collaboration turned off'

export interface ConversationCollabTurn {
  /** The digital human's conversation this turn runs in, or its run's sender key for a scheduled run. */
  conversationId: string
  /** The turn is somebody else's request to this digital human (IM guest or borrowed team turn). */
  delegated: boolean
  /** The turn runs in a team channel. */
  team: boolean
}

export interface ConversationCollabMount {
  /** False builds `conversation_read` only. */
  includeSend: boolean
}

/**
 * Where the tools may act from: a chat the conversation directory exposes for
 * this digital human (default or local session), or one of its scheduled runs.
 */
function isCollabIdentity(appId: string, conversationId: string): boolean {
  return (parseNativeChatKey(conversationId) ?? parseRunSenderKey(conversationId))?.appId === appId
}

/** Null when the tools must not be mounted for this turn. */
export function resolveConversationCollab(
  app: Pick<InstalledApp, 'id' | 'permissions' | 'spec'>,
  turn: ConversationCollabTurn
): ConversationCollabMount | null {
  if (!isConversationCollabEnabled(app)) return null
  if (turn.delegated || turn.team) return null
  if (!isCollabIdentity(app.id, turn.conversationId)) return null
  const agent = getConfig().agent
  if (agent?.enableConversationInterop === false) return null
  return { includeSend: agent?.enableConversationSend !== false }
}

/**
 * The tools themselves, scoped to the digital human's chat identity.
 */
export async function createConversationCollabMcpServer(
  scope: { spaceId: string; conversationId: string },
  mount: ConversationCollabMount
): Promise<unknown> {
  const { createConversationInteropMcpServer } = await import('../../services/conversation-interop')
  return createConversationInteropMcpServer(scope, mount.includeSend)
}
