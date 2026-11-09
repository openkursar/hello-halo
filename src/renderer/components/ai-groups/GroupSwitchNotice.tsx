/**
 * One line above the composer while a waiting reply is moved to another model.
 * It is Halo's own state: nothing is added to the chat.
 */

import { useTranslation } from '../../i18n'
import { useChatStore, selectActiveConversationId, useIsGenerating } from '../../stores/chat.store'
import { useActiveGroup } from '../../hooks/useActiveGroup'
import { useConversationGroupRoute } from '../../hooks/useConversationGroupRoute'
import { describeSwitchNotice } from './group-text'

export function GroupSwitchNotice() {
  const group = useActiveGroup()
  // Nothing is subscribed or read for a conversation that is not on a group.
  return group ? <Switching groupId={group.id} /> : null
}

function Switching({ groupId }: { groupId: string }) {
  const { t } = useTranslation()
  const activeId = useChatStore(selectActiveConversationId)
  const sessionId = useChatStore(state => {
    const conversation = activeId ? state.conversationCache.get(activeId) : undefined
    return conversation?.engineBinding?.sessionId ?? conversation?.sessionId
  })
  const live = useIsGenerating()
  const route = useConversationGroupRoute(activeId ? { id: activeId, sessionId } : null, groupId)
  const notice = describeSwitchNotice(route, t, live)
  // Always mounted for a conversation on a group: a region added together with its text is not announced.
  return (
    <div role="status" aria-live="polite" className="mx-3 sm:mx-4">
      {notice && (
        <p className="mb-1 break-words text-xs leading-relaxed text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  )
}
