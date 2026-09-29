/**
 * useUserTerminal — user-initiated terminal sessions for the current space.
 *
 * Availability mirrors the toolset broker's catalog (the renderer's
 * platform-availability signal for `ai-terminal`; the entry hides itself on
 * platforms without pty support). The catalog is read per conversation, but the
 * answer is a property of the platform, so it is read through the space's
 * regular conversation — the same whether that conversation or a digital
 * human's is on screen. Creation goes through the terminal store and reveals
 * the new session in the Canvas.
 */

import { useState, useCallback, useEffect } from 'react'
import { useSpaceStore } from '../stores/space.store'
import { useChatStore, type ChatState } from '../stores/chat.store'
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

/**
 * The conversation whose toolset catalog stands for the platform: the space's
 * regular conversation, which exists whatever the user is looking at.
 */
export function terminalProbeConversationId(state: Pick<ChatState, 'currentSpaceId' | 'spaceStates'>): string | null {
  return state.currentSpaceId ? state.spaceStates.get(state.currentSpaceId)?.currentConversationId ?? null : null
}

export function useUserTerminal(): UserTerminal {
  const [creating, setCreating] = useState(false)

  const spaceId = useSpaceStore((s) => s.currentSpace?.id ?? null)
  const probeId = useChatStore(terminalProbeConversationId)
  const ensureLoaded = useToolsetsStore((s) => s.ensureLoaded)
  const available = useToolsetsStore((s) =>
    probeId
      ? (s.byConversation.get(probeId) ?? []).some((ts) => ts.id === 'ai-terminal')
      : false
  )

  // With a digital human on screen nothing else loads the regular conversation's catalog.
  useEffect(() => {
    if (spaceId && probeId) void ensureLoaded(spaceId, probeId)
  }, [spaceId, probeId, ensureLoaded])
  const createSession = useTerminalStore((s) => s.createSession)
  const openInCanvas = useTerminalStore((s) => s.openInCanvas)

  const createAndOpen = useCallback(async () => {
    if (!spaceId || creating) return
    setCreating(true)
    try {
      const info = await createSession(spaceId)
      if (info) await openInCanvas(info.id, info.title)
    } finally {
      setCreating(false)
    }
  }, [spaceId, creating, createSession, openInCanvas])

  return { available: available && spaceId != null, creating, createAndOpen }
}
