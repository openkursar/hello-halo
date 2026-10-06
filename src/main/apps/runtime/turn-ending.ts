/**
 * apps/runtime -- A turn that stopped before its answer was done
 *
 * Two ways a turn ends short without the person stopping it: it reached the
 * step limit, or it was cut off. Halo's chat page shows that on its own (the
 * engine's notice); an IM chat only has the text it is sent, so its reply
 * carries a note — after whatever was written, or alone when nothing was — and
 * the message it answers is still finished.
 */

import type { StreamResult } from '../../services/agent/stream-processor'
import { readUserAgentSettings } from '../../services/agent/user-agent-settings'
import { DEFAULT_MAX_TURNS } from '../../../shared/constants/agent-limits'

/** How a turn left its answer unfinished, other than by the person's own stop. */
export type AppChatTurnEnding = 'max_turns' | 'interrupted'

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
  if (result.reachedMaxTurns) return 'max_turns'
  return result.isInterrupted ? 'interrupted' : undefined
}

/**
 * `content` as an IM chat should receive it after a turn that ended short: the
 * note follows what was written, or stands alone when nothing was. Hardcoded
 * Chinese like the other IM-facing notices: the backend has no renderer i18n.
 */
export function withTurnEndingNote(content: string, ending: AppChatTurnEnding): string {
  const note = ending === 'max_turns'
    ? `（已达到单次最多 ${readUserAgentSettings().maxTurns ?? DEFAULT_MAX_TURNS} 步的上限，回复“继续”可接着做）`
    : '（本轮意外中断，回复“继续”可接着做）'
  const written = content.trimEnd()
  return written.trim() ? `${written}\n\n${note}` : note
}
