/**
 * Which of a reply's text steps are already on screen elsewhere, so a sentence
 * is drawn once: the final answer below the work, or the words a running reply
 * is still writing. Comparison ignores whitespace, because the engine joins
 * consecutive text blocks with blank lines.
 */

import type { Thought } from '../../../types'
import { isArrivalThought } from '../transcript'

const NONE: ReadonlySet<string> = new Set()

/** A text step with words in it: something the AI said to the person. */
export function isSpokenText(step: Thought): boolean {
  return step.type === 'text' && !isArrivalThought(step) && step.content.trim().length > 0
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 160
}

/** Where `piece` ends in `text` when it matches from `from` on, or -1. */
function matchFrom(text: string, from: number, piece: string): number {
  let i = from
  let j = 0
  for (;;) {
    while (i < text.length && isSpace(text.charCodeAt(i))) i++
    while (j < piece.length && isSpace(piece.charCodeAt(j))) j++
    if (j === piece.length) return i
    if (i === text.length || text.charCodeAt(i) !== piece.charCodeAt(j)) return -1
    i++
    j++
  }
}

/** Where `piece` starts in `text` when it matches up to `to`, or -1. */
function matchUpTo(text: string, to: number, piece: string): number {
  let i = to - 1
  let j = piece.length - 1
  for (;;) {
    while (i >= 0 && isSpace(text.charCodeAt(i))) i--
    while (j >= 0 && isSpace(piece.charCodeAt(j))) j--
    if (j < 0) return i + 1
    if (i < 0 || text.charCodeAt(i) !== piece.charCodeAt(j)) return -1
    i--
    j--
  }
}

function blankBefore(text: string, end: number): boolean {
  for (let i = 0; i < end; i++) if (!isSpace(text.charCodeAt(i))) return false
  return true
}

/**
 * The text steps the saved answer is made of: the latest ones whose words end
 * the answer. A reply stopped mid-work keeps its last words as its content, so
 * those are matched too and shown once, in the answer's place.
 */
export function answerTextIds(steps: readonly Thought[], answer: string | undefined): ReadonlySet<string> {
  if (!answer || blankBefore(answer, answer.length)) return NONE
  const ids = new Set<string>()
  let end = answer.length
  for (let at = steps.length - 1; at >= 0; at--) {
    const step = steps[at]
    if (!isSpokenText(step)) continue
    const start = matchUpTo(answer, end, step.content)
    if (start < 0) break
    ids.add(step.id)
    end = start
    if (blankBefore(answer, end)) break
  }
  return ids.size > 0 ? ids : NONE
}

/**
 * The text steps a running reply's latest words below the work already hold.
 * The engine joins every text block since its last substantive tool into those
 * words, however many there are, so they start with a run of the latest text
 * steps, followed by words not recorded yet. The run is found by where the
 * words start: a step they do not start with is passed over at its first
 * character, so the search stays cheap on every token.
 */
export function liveTextIds(steps: readonly Thought[], live: string | undefined): ReadonlySet<string> {
  if (!live || blankBefore(live, live.length)) return NONE
  let from = -1
  for (let at = steps.length - 1; at >= 0; at--) {
    if (isSpokenText(steps[at]) && matchFrom(live, 0, steps[at].content) >= 0 && runMatches(steps, at, live)) from = at
  }
  if (from < 0) return NONE
  const ids = new Set<string>()
  for (let at = from; at < steps.length; at++) if (isSpokenText(steps[at])) ids.add(steps[at].id)
  return ids
}

/** Whether `live` starts with every text step from `from` on, in order. */
function runMatches(steps: readonly Thought[], from: number, live: string): boolean {
  let end = 0
  for (let at = from; at < steps.length && end >= 0; at++) {
    if (isSpokenText(steps[at])) end = matchFrom(live, end, steps[at].content)
  }
  return end >= 0
}

/** `next` when it names other steps than `prev`, else `prev`, so an unchanged set keeps its identity. */
export function sameIdsOr(prev: ReadonlySet<string>, next: ReadonlySet<string>): ReadonlySet<string> {
  if (prev === next) return prev
  if (prev.size !== next.size) return next
  for (const id of next) if (!prev.has(id)) return next
  return prev
}
