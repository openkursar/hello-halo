/**
 * The user's goal changes, shared by the shelf, the composer and the editor so
 * each behaves the same way: shown at once, rolled back with a notice when
 * main refuses, and clearing an active goal offers Undo.
 */

import i18n from '../../i18n'
import { useGoalStore, type Goal, type GoalInput } from '../../stores/goal.store'
import { useGoalUiStore } from '../../stores/goal-ui.store'
import { useNotificationStore } from '../../stores/notification.store'

/** What the goal will look like once main applies the user's input. */
export function pendingGoal(input: GoalInput): Goal {
  return {
    objective: input.objective,
    doneWhen: input.doneWhen ?? [],
    status: 'active',
    updatedBy: 'user',
    updatedAt: new Date().toISOString(),
  }
}

export function toGoalInput(goal: Goal): GoalInput {
  return { objective: goal.objective, doneWhen: [...goal.doneWhen] }
}

export function notifyGoalUpdateFailed(): void {
  useNotificationStore.getState().show({
    id: 'goal-update-failed',
    title: i18n.t("Couldn't update the goal. Try again."),
    variant: 'error',
    duration: 6000,
  })
}

/** Replace the goal without starting a turn. Resolves whether main accepted it. */
export async function saveGoal(spaceId: string, conversationId: string, input: GoalInput): Promise<boolean> {
  const store = useGoalStore.getState()
  const rollback = store.applyOptimistic(conversationId, pendingGoal(input))
  const result = await store.set(spaceId, conversationId, input)
  if (result.success) return true
  rollback()
  notifyGoalUpdateFailed()
  return false
}

/**
 * Remove the goal. An active goal can be brought back for a few seconds; a
 * finished one cannot, because main can only restore a goal as active, which
 * would send Halo back to work it already finished.
 */
export async function clearGoal(spaceId: string, conversationId: string, goal: Goal): Promise<boolean> {
  const store = useGoalStore.getState()
  const ui = useGoalUiStore.getState()
  const undoable = goal.status === 'active'
  // Undo is offered before the goal disappears, so the shelf never renders a gap between them.
  ui.setExpanded(conversationId, false)
  if (undoable) ui.offerUndo(conversationId, toGoalInput(goal))
  const rollback = store.applyOptimistic(conversationId, null)
  const result = await store.clear(spaceId, conversationId)
  if (result.success) return true
  rollback()
  if (undoable) useGoalUiStore.getState().dropUndo(conversationId)
  notifyGoalUpdateFailed()
  return false
}

export async function undoClearGoal(spaceId: string, conversationId: string): Promise<void> {
  const entry = useGoalUiStore.getState().undo.get(conversationId)
  if (!entry) return
  useGoalUiStore.getState().dropUndo(conversationId, entry.id)
  await saveGoal(spaceId, conversationId, entry.previous)
}
