/**
 * useUserTerminal — user-initiated terminal sessions for the current space.
 *
 * Availability mirrors the toolset broker's per-conversation catalog (the
 * renderer's platform-availability signal for `ai-terminal`; the entry hides
 * itself on platforms without pty support). Creation goes through the terminal
 * store and reveals the new session in the Canvas.
 */

import { useState, useCallback } from 'react'
import { useSpaceStore } from '../stores/space.store'
import { useChatStore } from '../stores/chat.store'
import { useToolsetsStore } from '../stores/toolsets.store'
import { useTerminalStore } from '../stores/terminal.store'

interface UserTerminal {
  /** Whether the terminal capability exists here (platform + space ready). */
  available: boolean
  /** A create request is in flight. */
  creating: boolean
  /** Create a user-owned session and open it in the Canvas. */
  createAndOpen: () => Promise<void>
}

export function useUserTerminal(): UserTerminal {
  const [creating, setCreating] = useState(false)

  const spaceId = useSpaceStore((s) => s.currentSpace?.id ?? null)
  const getCurrentConversationId = useChatStore((s) => s.getCurrentConversationId)
  const conversationId = getCurrentConversationId()
  const available = useToolsetsStore((s) =>
    conversationId
      ? (s.byConversation.get(conversationId) ?? []).some((ts) => ts.id === 'ai-terminal')
      : false
  )
  const createSession = useTerminalStore((s) => s.createSession)
  const openInCanvas = useTerminalStore((s) => s.openInCanvas)

  const createAndOpen = useCallback(async () => {
    if (!spaceId || creating) return
    setCreating(true)
    try {
      const info = await createSession(spaceId)
      if (info) openInCanvas(info.id, info.title)
    } finally {
      setCreating(false)
    }
  }, [spaceId, creating, createSession, openInCanvas])

  return { available: available && spaceId != null, creating, createAndOpen }
}
