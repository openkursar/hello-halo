/**
 * Quick-jump candidates for the command palette (SearchPanel's empty-query
 * and title-match views) — prototype's CMDK_ITEMS, but built from real data
 * instead of a static demo list.
 *
 * Conversations come from the current space only — the set the sidebar has
 * already loaded. Other spaces' lists live on disk, one index per space, and
 * reading them all whenever the palette opens would grow with the user's
 * data; each row and its section name the space instead, so the list never
 * claims more than it holds.
 */
import { useMemo } from 'react'
import { useChatStore, usePulseItems } from '@/stores/chat.store'
import { useAppsStore } from '@/stores/apps.store'
import { useSpaceNameResolver } from '@/stores/space.store'
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
  const spaceName = useSpaceNameResolver()
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
        meta: spaceName(currentSpaceId!),
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
        meta: spaceName(p.spaceId),
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
  }, [currentSpaceId, spaceStates, pulseItems, spaceName, apps, kbs, t])
}
