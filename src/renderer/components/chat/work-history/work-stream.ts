/**
 * A reply's work as a timeline: what the AI said along the way, records it
 * received, and between them each stretch of operations as one group. Long
 * work grows the timeline by what was said, not by how many tools ran.
 *
 * Derived from the work model's steps (`display`), which already leave out
 * the final result, sub-agent steps and the todo list.
 */

import type { Thought } from '../../../types'
import { isArrivalThought, type ArrivalThought } from '../transcript'

export type WorkEntry =
  /** Words the AI said to the person along the way. */
  | { kind: 'speech'; id: string; thought: Thought }
  /** Records received in a row (a teammate's report, another conversation's message). */
  | { kind: 'arrivals'; id: string; thoughts: readonly ArrivalThought[] }
  /** A step with a line of its own: the session notice, a compaction, a sub-agent's task, an engine error. */
  | { kind: 'step'; id: string; thought: Thought }
  /** Operations and reasoning between two of the above. */
  | { kind: 'group'; id: string; steps: readonly Thought[] }

export interface WorkStream {
  readonly steps: readonly Thought[]
  readonly entries: readonly WorkEntry[]
}

/** Tools whose work is a task of its own, followed on its own line. */
const TASK_TOOLS = new Set(['Task', 'Agent'])

/**
 * Steps that are not operations of a stretch: the session notice ("Connected |
 * Model: …", the reply's first line, as it always was), a compaction, a
 * sub-agent's task, an engine error.
 */
function standsAlone(step: Thought): boolean {
  return step.type === 'system' || step.type === 'error' || (step.type === 'tool_use' && TASK_TOOLS.has(step.toolName ?? ''))
}

/** Reasoning with nothing in it, once the reply is saved, is not shown. */
function isEmptyReasoning(step: Thought, live: boolean): boolean {
  return step.type === 'thinking' && !step.content.trim() && !(live && step.isStreaming)
}

function sameSteps(a: readonly Thought[], b: readonly Thought[]): boolean {
  return a.length === b.length && a.every((step, i) => step === b[i])
}

/** `prev`'s entry when it shows the same steps, so its line is not drawn again. */
function reuse(prev: ReadonlyMap<string, WorkEntry> | undefined, next: WorkEntry): WorkEntry {
  const before = prev?.get(next.id)
  if (!before || before.kind !== next.kind) return next
  switch (next.kind) {
    case 'group': return sameSteps((before as typeof next).steps, next.steps) ? before : next
    case 'arrivals': return sameSteps((before as typeof next).thoughts, next.thoughts) ? before : next
    default: return (before as typeof next).thought === next.thought ? before : next
  }
}

/**
 * The timeline for `steps`. `shownBelow` are the text steps the reply shows
 * under its work (its answer, or the words it is still writing); they are left
 * out here. Entries whose steps did not change keep their identity from `prev`.
 */
export function nextWorkStream(prev: WorkStream | null, steps: readonly Thought[], shownBelow: ReadonlySet<string>, live: boolean): WorkStream {
  const earlier = prev ? new Map(prev.entries.map(entry => [entry.id, entry])) : undefined
  const entries: WorkEntry[] = []
  let group: Thought[] = []
  let arrivals: ArrivalThought[] = []
  const endGroup = () => {
    if (group.length > 0) entries.push(reuse(earlier, { kind: 'group', id: group[0].id, steps: group }))
    group = []
  }
  const endArrivals = () => {
    if (arrivals.length > 0) entries.push(reuse(earlier, { kind: 'arrivals', id: arrivals[0].id, thoughts: arrivals }))
    arrivals = []
  }
  for (const step of steps) {
    if (isArrivalThought(step)) {
      endGroup()
      arrivals.push(step)
      continue
    }
    if (step.type === 'text') {
      if (!step.content.trim() || shownBelow.has(step.id)) continue
      endGroup()
      endArrivals()
      entries.push(reuse(earlier, { kind: 'speech', id: step.id, thought: step }))
      continue
    }
    if (isEmptyReasoning(step, live)) continue
    endArrivals()
    if (standsAlone(step)) {
      endGroup()
      entries.push(reuse(earlier, { kind: 'step', id: step.id, thought: step }))
      continue
    }
    group.push(step)
  }
  endGroup()
  endArrivals()
  return { steps, entries }
}

/** Whether the reply did anything worth opening besides the words shown below it. */
export function hasWorkToShow(steps: readonly Thought[], shownBelow: ReadonlySet<string>, live: boolean): boolean {
  for (const step of steps) {
    if (isArrivalThought(step)) return true
    if (step.type === 'text') {
      if (step.content.trim() && !shownBelow.has(step.id)) return true
    } else if (step.type === 'system') {
      if (step.compaction) return true
    } else if (!isEmptyReasoning(step, live)) {
      return true
    }
  }
  return false
}
