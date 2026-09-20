/**
 * Quick-jump candidates for the command palette (SearchPanel's empty-query
 * and title-match views) — prototype's CMDK_ITEMS, but built from real data
 * instead of a static demo list.
 *
 * Scope note: conversations are drawn from the *current* space only (the
 * same set already loaded for the sidebar), not aggregated across every
 * space — a cross-space conversation index doesn't exist yet, and building
 * one is out of scope for a command-palette quick-jump.
 */
import { useMemo } from 'react'
import { useChatStore, usePulseItems } from '@/stores/chat.store'
import { useAppsStore } from '@/stores/apps.store'
import { useTlonStore } from '@/stores/tlon.store'
import { useTranslation } from '@/i18n'

export type QuickJumpType = 'conv' | 'agent' | 'task' | 'kb'

export interface QuickJumpItem {
  type: QuickJumpType
  key: string
  title: string
  meta: string
  updatedAt?: string
  conversationId?: string
  spaceId?: string
  appId?: string
  kbId?: string
}

export function useQuickJumpCandidates(): QuickJumpItem[] {
  const { t } = useTranslation()
  const currentSpaceId = useChatStore(state => state.currentSpaceId)
  const spaceStates = useChatStore(state => state.spaceStates)
  const pulseItems = usePulseItems()
  const apps = useAppsStore(state => state.apps)
  const kbs = useTlonStore(state => state.kbs)

  return useMemo(() => {
    const items: QuickJumpItem[] = []

    const conversations = currentSpaceId ? spaceStates.get(currentSpaceId)?.conversations ?? [] : []
    for (const c of conversations) {
      items.push({
        type: 'conv',
        key: `conv:${c.id}`,
        title: c.title,
        meta: t('Conversation'),
        updatedAt: c.updatedAt,
        conversationId: c.id,
        spaceId: currentSpaceId!,
      })
    }

    for (const p of pulseItems) {
      items.push({
        type: 'task',
        key: `task:${p.conversationId}`,
        title: p.title,
        meta: p.spaceName,
        updatedAt: p.updatedAt,
        conversationId: p.conversationId,
        spaceId: p.spaceId,
      })
    }

    for (const a of apps) {
      if (a.spec.type !== 'automation') continue
      items.push({
        type: 'agent',
        key: `agent:${a.id}`,
        title: a.spec.name,
        meta: t('Digital Human'),
        appId: a.id,
      })
    }

    for (const k of kbs) {
      items.push({
        type: 'kb',
        key: `kb:${k.id}`,
        title: k.name,
        meta: k.description || t('Knowledge Base'),
        kbId: k.id,
      })
    }

    return items
  }, [currentSpaceId, spaceStates, pulseItems, apps, kbs, t])
}
