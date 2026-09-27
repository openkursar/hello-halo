/**
 * Turns what the user typed in composer goal mode into a goal.
 *
 * Lines that start like a list item ("- ", "* ", "• ", "1. ", "2) ", "[ ] ")
 * become done-when criteria with the marker removed; every other line, in
 * order, is the objective. Pure, so the composer and its tests share it.
 */

import type { GoalInput } from '../../../shared/types/goal'

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)]|\[ ?\])\s+/
// "- [ ] item" is a markdown task item: the box belongs to the marker, not the criterion.
const TASK_BOX = /^\[[ xX]?\]\s+/

/** The goal the draft describes, or null when it has no objective. */
export function parseGoalDraft(text: string): GoalInput | null {
  const objectiveLines: string[] = []
  const doneWhen: string[] = []

  for (const line of text.split(/\r?\n/)) {
    const marker = LIST_MARKER.exec(line)
    if (marker) {
      const criterion = line.slice(marker[0].length).replace(TASK_BOX, '').trim()
      if (criterion) doneWhen.push(criterion)
    } else {
      objectiveLines.push(line)
    }
  }

  const objective = objectiveLines.join('\n').trim()
  return objective ? { objective, doneWhen } : null
}
