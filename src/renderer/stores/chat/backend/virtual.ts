/**
 * Digital-human sessions the chat board does not show (IM, HTTP, team member).
 *
 * The store only tracks their live turn; their transcript belongs to the view
 * that displays it. So the one verb that matters here is ending a turn: there
 * is nothing to reload, the streamed state is simply retired. Thoughts of a
 * local team member's reply are the exception: they are read on demand.
 */
import { api } from '../internal'
import type { Thought } from '../internal'
import { finishedTurnState } from './turn'
import type { ChatBackend, ConversationRef, BackendContext } from './types'
import { parseTeamSessionKey } from '../../../../shared/apps/im-keys'
import { isRemoteMemberAppId } from '../../team.store'

function unsupported(verb: string, conversationId: string): never {
  throw new Error(`${verb} is not available for ${conversationId}`)
}

async function settleTurn(ctx: BackendContext, ref: ConversationRef, turnId: number): Promise<void> {
  // A remote team member has no local transcript, so its relayed stream is the
  // only record: keep it and stop the in-progress indicators.
  const team = parseTeamSessionKey(ref.conversationId)
  const preserveRelayed = !!team && isRemoteMemberAppId(team.teamId, team.appId)

  ctx.set((state) => {
    const sessions = new Map(state.sessions)
    const session = sessions.get(ref.conversationId)
    if (session && session.turnId === turnId) {
      // No sendMessage resets these between turns, so stale thoughts would
      // otherwise show up in the next turn's thought process.
      sessions.set(ref.conversationId, {
        ...finishedTurnState(session),
        isThinking: false,
        streamingContent: preserveRelayed ? session.streamingContent : '',
        thoughts: preserveRelayed ? session.thoughts : [],
      })
    } else if (session) {
      console.log(`[ChatStore] Skipping session clear for [${ref.conversationId}]: new turn started`)
    }
    return { sessions }
  })
}

/** A local team member's reply keeps its process in the member's own transcript; a remote member's is not on this machine. */
async function loadThoughts(_ctx: BackendContext, ref: ConversationRef, messageId: string): Promise<Thought[]> {
  const team = parseTeamSessionKey(ref.conversationId)
  if (!team || isRemoteMemberAppId(team.teamId, team.appId)) return []
  try {
    const response = await api.appChatMessageThoughts({ appId: team.appId, spaceId: ref.spaceId, conversationId: ref.conversationId, messageId })
    return response.success && Array.isArray(response.data) ? response.data as Thought[] : []
  } catch (error) {
    console.error(`[ChatStore/Virtual] Failed to load thoughts for ${ref.conversationId}/${messageId}:`, error)
    return []
  }
}

export const virtualBackend: ChatBackend = {
  async open() {},
  async refresh() {},
  async send(_ctx, conversationId) { return unsupported('send', conversationId) },
  async stop(_ctx, conversationId) { return unsupported('stop', conversationId) },
  async inject(_ctx, conversationId) { return unsupported('inject', conversationId) },
  settleTurn,
  loadThoughts,
  async loadEarlier() {},
  async loadThrough() {},
}
