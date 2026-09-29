/**
 * "Clear chat" for a conversation that outlives its history (a digital
 * human's default session). Sits in the transcript footer, so it is reached at
 * the end of the conversation and confirms before anything is erased.
 */

import { useState } from 'react'
import { Eraser } from 'lucide-react'
import { useChatStore } from '../../stores/chat.store'
import { useTranslation } from '../../i18n'

export function ClearChatControl({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation()
  const clearConversation = useChatStore(s => s.clearConversation)
  const [confirming, setConfirming] = useState(false)

  const handleClear = async () => {
    try {
      await clearConversation(conversationId)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="pb-4">
      {confirming ? (
        <div className="flex items-center justify-end gap-2">
          <span className="text-[11px] text-muted-foreground/80">{t('Clear all chat history?')}</span>
          <button
            onClick={handleClear}
            className="px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 rounded transition-colors"
          >
            {t('Confirm')}
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary rounded transition-colors"
          >
            {t('Cancel')}
          </button>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            onClick={() => setConfirming(true)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors rounded"
            title={t('Clear chat history')}
          >
            <Eraser className="w-3 h-3" />
            {t('Clear chat')}
          </button>
        </div>
      )}
    </div>
  )
}
