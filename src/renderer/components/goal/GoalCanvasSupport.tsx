/**
 * What goal editor tabs need from the canvas while not the visible tab: a
 * prompt before a tab with unsaved changes is closed, and a title that names
 * the conversation, kept in step when it is renamed. Mounted at the space
 * level, beside the canvas.
 */

import { useEffect, useRef, useState } from 'react'
import { canvasLifecycle } from '../../services/canvas-lifecycle'
import { useChatStore } from '../../stores/chat.store'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useTranslation } from '../../i18n'

export function GoalCanvasSupport() {
  const { t } = useTranslation()
  const [asking, setAsking] = useState(false)
  const resolveRef = useRef<((discard: boolean) => void) | null>(null)

  const settle = (discard: boolean) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setAsking(false)
    resolve?.(discard)
  }

  useEffect(() => {
    const unregister = canvasLifecycle.setDirtyCloseGuard('goal', () =>
      new Promise<boolean>((resolve) => {
        // A second close while the prompt is open replaces it; the first caller keeps its tab.
        resolveRef.current?.(false)
        resolveRef.current = resolve
        setAsking(true)
      })
    )
    return () => {
      unregister()
      resolveRef.current?.(false)
      resolveRef.current = null
    }
  }, [])

  useEffect(() => {
    const syncTitles = () => {
      const spaces = useChatStore.getState().spaceStates
      for (const tab of canvasLifecycle.getTabs()) {
        if (tab.type !== 'goal' || !tab.goal) continue
        const { spaceId, conversationId } = tab.goal
        const title = spaces.get(spaceId)?.conversations.find((c) => c.id === conversationId)?.title
        canvasLifecycle.setTabTitle(tab.id, title ? t('Goal · {{title}}', { title }) : t('Goal'))
      }
    }
    syncTitles()
    const unsubscribeTabs = canvasLifecycle.onTabsChange(syncTitles)
    const unsubscribeChat = useChatStore.subscribe((state, previous) => {
      if (state.spaceStates !== previous.spaceStates) syncTitles()
    })
    return () => {
      unsubscribeTabs()
      unsubscribeChat()
    }
  }, [t])

  if (!asking) return null

  return (
    <ConfirmDialog
      title={t('Discard changes to this goal?')}
      confirmLabel={t('Discard')}
      cancelLabel={t('Keep editing')}
      variant="danger"
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  )
}
