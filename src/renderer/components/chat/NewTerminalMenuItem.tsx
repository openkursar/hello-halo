/**
 * NewTerminalMenuItem — "+ menu" entry that opens a fresh user-owned terminal
 * in the Canvas. Lets the user work in a shell directly (or pre-login for the
 * AI to take over, e.g. SSH) without waiting for the AI to create one.
 *
 * Hidden when the terminal toolset is unavailable on this platform (the
 * toolset list from the broker is the renderer's availability signal).
 */

import { useState } from 'react'
import { TerminalSquare, Loader2 } from 'lucide-react'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { useChatStore } from '../../stores/chat.store'
import { useToolsetsStore } from '../../stores/toolsets.store'
import { useTerminalStore } from '../../stores/terminal.store'
import { useTranslation } from '../../i18n'

interface NewTerminalMenuItemProps {
  /** Close the parent menu after the action */
  onClose: () => void
}

export function NewTerminalMenuItem({ onClose }: NewTerminalMenuItemProps) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)

  const currentSpace = useSpaceStore((s) => s.currentSpace)
  const getCurrentConversationId = useChatStore((s) => s.getCurrentConversationId)
  const conversationId = getCurrentConversationId()
  const available = useToolsetsStore((s) =>
    conversationId
      ? (s.byConversation.get(conversationId) ?? []).some(ts => ts.id === 'ai-terminal')
      : false
  )
  const openInCanvas = useTerminalStore((s) => s.openInCanvas)

  if (!currentSpace?.id || !available) return null

  const handleCreate = async () => {
    if (creating) return
    setCreating(true)
    try {
      const res = await api.createTerminal({ spaceId: currentSpace.id })
      if (res.success && res.data) {
        const info = res.data as { id: string; title: string }
        openInCanvas(info.id, info.title)
        onClose()
      } else {
        console.error('[NewTerminal] create failed:', res.error)
      }
    } catch (err) {
      console.error('[NewTerminal] create error:', err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <button
      onClick={handleCreate}
      disabled={creating}
      className="w-full px-3 py-2 flex items-center gap-3 text-sm text-foreground
        hover:bg-muted/50 transition-colors duration-150 disabled:opacity-60"
    >
      {creating
        ? <Loader2 size={16} className="text-muted-foreground animate-spin" />
        : <TerminalSquare size={16} className="text-muted-foreground" />}
      <span>{t('New terminal')}</span>
    </button>
  )
}
