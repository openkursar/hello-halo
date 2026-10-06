/**
 * apps/runtime -- Recording a push in the chat it went to
 *
 * What a digital human sends to an IM chat outside that chat's turns —
 * `notify_bot`, a run's result sent to the chats that receive results, a
 * question for the owner — goes into the chat's record here (chat-record).
 *
 * Loaded on use: the record's writer belongs to the chat runtime, which itself
 * loads the senders, and a push has already gone out by the time it is noted.
 */

import type { ChatPushVia } from '../../../shared/types/transcript'

export interface ChatPush {
  /** The digital human the chat belongs to, as the session registry keys it */
  appId: string
  /** The channel provider type, as the session registry keys it */
  channel: string
  chatType: 'direct' | 'group'
  chatId: string
  /** What the chat received */
  text: string
  via: ChatPushVia
}

/** Note a push that was sent. Never throws and never waits. */
export function recordChatPush(push: ChatPush): void {
  void import('./chat-record')
    .then(({ writeChatPush }) => writeChatPush(push))
    .catch((err) => console.warn(`[ChatPush] A push to ${push.channel}:${push.chatId} was sent but not recorded:`, err))
}
