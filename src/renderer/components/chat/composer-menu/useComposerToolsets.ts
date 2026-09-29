/**
 * The current conversation's toolsets, as the composer's "+" panel shows them.
 *
 * Mounted with the composer rather than the panel, so an AI request to enable
 * a toolset (request_toolset) can open the panel even while it is closed.
 */

import { useEffect } from 'react'
import { useToolsetsStore, type ToolsetStatus } from '../../../stores/toolsets.store'
import { useChatStore } from '../../../stores/chat.store'
import { useSpaceStore } from '../../../stores/space.store'
import { DEFAULT_TOOLSETS } from '../../../../shared/constants/toolsets'

const EMPTY: ToolsetStatus[] = []
const HIGHLIGHT_MS = 2400

interface Options {
  /** False on surfaces whose tools are not governed by the broker (digital-human chat). */
  enabled: boolean
  /** A request waits for the running turn to end, when the "+" button is back. */
  canOpen: boolean
  /** Whether the panel is showing, so a highlight is consumed only once seen. */
  panelOpen: boolean
  onRequested: () => void
}

export interface ComposerToolsets {
  list: ToolsetStatus[]
  /** Enabled beyond the defaults — the only toolset state worth showing at rest. */
  extraEnabled: ToolsetStatus[]
  requested: ReadonlySet<string>
  toggle: (toolset: ToolsetStatus) => void
}

export function useComposerToolsets({ enabled, canOpen, panelOpen, onRequested }: Options): ComposerToolsets {
  const spaceId = useSpaceStore((s) => s.currentSpace?.id ?? null)
  const conversationId = useChatStore((s) => s.getCurrentConversationId())
  const active = enabled && !!spaceId && !!conversationId

  const statuses = useToolsetsStore((s) => (active ? s.byConversation.get(conversationId!) : undefined))
  const aiRequested = useToolsetsStore((s) => (active ? s.aiRequested.get(conversationId!) : undefined))
  const requestSignal = useToolsetsStore((s) => (active ? s.requestSignal.get(conversationId!) : undefined))
  const refresh = useToolsetsStore((s) => s.refresh)
  const openToolset = useToolsetsStore((s) => s.open)
  const closeToolset = useToolsetsStore((s) => s.close)
  const consumeRequestHighlight = useToolsetsStore((s) => s.consumeRequestHighlight)
  const consumeRequestSignal = useToolsetsStore((s) => s.consumeRequestSignal)

  useEffect(() => {
    if (active) void refresh(spaceId!, conversationId!)
  }, [active, spaceId, conversationId, refresh])

  // Consumed at once so a later remount never re-opens the panel.
  useEffect(() => {
    if (!active || !requestSignal || !canOpen) return
    consumeRequestSignal(conversationId!)
    onRequested()
  }, [active, requestSignal, canOpen, conversationId, consumeRequestSignal, onRequested])

  useEffect(() => {
    if (!active || !panelOpen || !aiRequested || aiRequested.size === 0) return
    const timers = Array.from(aiRequested).map((id) =>
      window.setTimeout(() => consumeRequestHighlight(conversationId!, id), HIGHLIGHT_MS)
    )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [active, panelOpen, aiRequested, conversationId, consumeRequestHighlight])

  const list = active ? statuses ?? EMPTY : EMPTY

  return {
    list,
    extraEnabled: list.filter((ts) => ts.open && !DEFAULT_TOOLSETS.includes(ts.id)),
    requested: aiRequested ?? new Set<string>(),
    toggle: (ts) => {
      if (!active) return
      if (ts.open) void closeToolset(spaceId!, conversationId!, ts.id)
      else void openToolset(spaceId!, conversationId!, ts.id)
    },
  }
}
