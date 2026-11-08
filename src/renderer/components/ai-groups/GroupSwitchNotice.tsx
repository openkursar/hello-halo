/**
 * One line above the composer while a waiting reply is moved to another model.
 * It is Halo's own state: nothing is added to the chat.
 */

import { Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useChatStore, selectActiveConversationId, useIsGenerating } from '../../stores/chat.store'
import { useActiveGroup } from '../../hooks/useActiveGroup'
import { useConversationGroupRoute } from '../../hooks/useConversationGroupRoute'
import { describeRoute } from './group-text'

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
  const view = describeRoute(route, t, live)
  // Always mounted for a conversation on a group: a region added together with its text is not announced.
  return (
    <div role="status" aria-live="polite" className="mx-3 sm:mx-4">
      {view.kind === 'switching' && (
        <p className="mb-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">
            {t('Trying another model: {{account}} / {{model}}', { account: view.member.account, model: view.member.model })}
          </span>
        </p>
      )}
    </div>
  )
}
