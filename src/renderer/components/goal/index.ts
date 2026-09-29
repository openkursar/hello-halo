/**
 * Conversation goal UI — composer goal mode, the shelf above the composer, the
 * canvas editor, and the history badge. Engine data comes from goal.store;
 * nothing here decides whether the engine supports goals beyond reading its
 * capability flag.
 */

export { useGoalComposer } from './useGoalComposer'
export type { GoalComposerConfig } from './types'
export { GoalEditor } from './GoalEditor'
export { GoalCanvasSupport } from './GoalCanvasSupport'
export { GoalSetBadge } from './GoalSetBadge'
export { parseGoalDraft } from './parseGoalDraft'
