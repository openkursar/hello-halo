/**
 * apps/runtime -- A turn that stopped before its answer was done
 *
 * Three ways a turn ends short without the person stopping it: it reached the
 * step limit, it was cut off, or a model request failed. Halo's chat page
 * shows that on its own (the engine's notice); an IM chat only has the text it
 * is sent, so its reply carries a note — after whatever was written, or alone
 * when nothing was — and the message it answers is still finished.
 */

import type { StreamResult } from '../../services/agent'

/**
 * How a turn left its answer unfinished, other than by the person's own stop.
 * The step limit is the one the engine reported: the session was built with
 * it, and the setting may have changed since. A failure carries the engine's
 * reason.
 */
export type AppChatTurnEnding =
  | { kind: 'max_turns'; limit?: number }
  | { kind: 'interrupted' }
  | { kind: 'failed'; error: string }

/** A round whose turn was cut off before it wrote anything. */
export class AppChatTurnInterrupted extends Error {
  constructor() {
    super('The model response was interrupted.')
    this.name = 'AppChatTurnInterrupted'
  }
}

/** How `result`'s turn ended short, if it did. A stop the person asked for is not one. */
export function turnEndingOf(result: StreamResult): AppChatTurnEnding | undefined {
  if (result.wasAborted) return undefined
  if (result.hasErrorThought) return { kind: 'failed', error: result.errorThought?.content || 'The model response was interrupted.' }
  if (result.reachedMaxTurns) {
    return result.maxTurnsLimit === undefined ? { kind: 'max_turns' } : { kind: 'max_turns', limit: result.maxTurnsLimit }
  }
  return result.isInterrupted ? { kind: 'interrupted' } : undefined
}

/**
 * `content` as an IM chat should receive it after a turn that ended short: the
 * note follows what was written, or stands alone when nothing was. Hardcoded
 * Chinese like the other IM-facing notices: the backend has no renderer i18n.
 * A failure's note is the chat's error notice: im-error-reply's imTurnReply.
 */
export function withTurnEndingNote(content: string, ending: Exclude<AppChatTurnEnding, { kind: 'failed' }>): string {
  const note = ending.kind === 'interrupted'
    ? '（本轮意外中断，回复“继续”可接着做）'
    : ending.limit === undefined
      ? '（已达到单次最多步数的上限，回复“继续”可接着做）'
      : `（已达到单次最多 ${ending.limit} 步的上限，回复“继续”可接着做）`
  const written = content.trimEnd()
  return written.trim() ? `${written}\n\n${note}` : note
}
