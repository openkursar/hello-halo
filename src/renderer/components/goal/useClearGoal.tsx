import { useState, type ReactNode } from 'react'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useTranslation } from '../../i18n'
import type { Goal } from '../../stores/goal.store'
import { clearGoal } from './goal-actions'

interface PendingClear {
  goal: Goal
  onCleared?: () => void
}

/**
 * Clearing an active goal is undoable and dismissing a finished one changes
 * nothing Halo is doing, so it asks first only when it changes what Halo is
 * doing right now: an active goal while a turn runs.
 */
export function useClearGoal(spaceId: string, conversationId: string, running: boolean): {
  requestClear: (goal: Goal, onCleared?: () => void) => void
  confirmDialog: ReactNode
} {
  const { t } = useTranslation()
  const [pending, setPending] = useState<PendingClear | null>(null)

  const run = (goal: Goal, onCleared?: () => void) => {
    void clearGoal(spaceId, conversationId, goal).then((ok) => {
      if (ok) onCleared?.()
    })
  }

  const requestClear = (goal: Goal, onCleared?: () => void) => {
    if (goal.status === 'active' && running) setPending({ goal, onCleared })
    else run(goal, onCleared)
  }

  const confirmDialog = pending ? (
    <ConfirmDialog
      title={t('Clear this goal?')}
      message={t('Halo is working toward it right now and will stop treating it as the target.')}
      confirmLabel={t('Clear goal')}
      cancelLabel={t('Cancel')}
      variant="danger"
      onConfirm={() => {
        setPending(null)
        run(pending.goal, pending.onCleared)
      }}
      onCancel={() => setPending(null)}
    />
  ) : null

  return { requestClear, confirmDialog }
}
