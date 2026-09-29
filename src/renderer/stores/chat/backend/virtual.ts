/**
 * Digital-human sessions the chat board does not show (IM, HTTP, team member).
 *
 * The store only tracks their live turn; their transcript belongs to the view
 * that displays it. So the one verb that matters here is ending a turn: there
 * is nothing to reload, the streamed state is simply retired.
 */
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
  const preserveRelayed = !!team && isRemoteMemberAppId(team.appId)

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

export const virtualBackend: ChatBackend = {
  async open() {},
  async refresh() {},
  async send(_ctx, conversationId) { return unsupported('send', conversationId) },
  async stop(_ctx, conversationId) { return unsupported('stop', conversationId) },
  async inject(_ctx, conversationId) { return unsupported('inject', conversationId) },
  settleTurn,
  async loadThoughts() { return [] },
  async loadEarlier() {},
  async loadThrough() {},
}
