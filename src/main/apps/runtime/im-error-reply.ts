/**
 * apps/runtime -- What an IM chat is told when its turn failed
 *
 * Said in place of the answer by every IM path that runs a turn
 * (dispatch-inbound, reminder delivery). An IM group may hold people from
 * outside, so nothing about the computer Halo runs on goes out: no path, no
 * program. Hardcoded Chinese like the other IM-facing notices.
 */

import { isRefusedLocalConnection } from '../../services/agent'
import { truncateUtf16Safe } from './text-truncate'
import { AppChatTurnInterrupted, withTurnEndingNote } from './turn-ending'

/** How much of an error an IM chat is shown. */
const MAX_ERROR_CHARS = 200

const REFUSED_LOCAL_CONNECTION_NOTE =
  '⚠️ Halo 所在电脑的安全软件拦截了本机连接，这次没能处理。请主人在 Halo 里查看并处理。'

/**
 * A turn's working folder (services/agent working-dir), told by the error's
 * name: what can be done about it, never the folder.
 */
const WORKING_FOLDER_NOTES = new Map([
  ['WorkingDirectoryUnavailableError', '⚠️ 这个数字人的工作目录暂时不可用，请主人在 Halo 里处理。'],
  ['WorkingDirectoryChangedError', '⚠️ 这个数字人的工作目录刚刚更换，请再发一次。'],
])

/** Where a path of this computer starts: a POSIX root, a drive, a network share, or a file URL. */
const PATH_START =
  String.raw`(?:\/(?:Users|home|Volumes|private|var|tmp|opt|root|mnt|media|srv|Applications|Library|System|usr|etc|run|snap|nix)\/` +
  String.raw`|[A-Za-z]:[\\\/]|\\\\|file:\/\/)`

/** A path in quotes, spaces and all. */
const QUOTED_PATH = new RegExp(String.raw`(['"\x60])${PATH_START}[^'"\x60\n]*\1`, 'g')

/**
 * A bare path, starting a word — a web address's path never does. A folder
 * name may hold spaces where another separator follows it; punctuation that
 * ends the path belongs to the sentence.
 */
const BARE_PATH = new RegExp(
  String.raw`(^|[\s(\[=,;])${PATH_START}(?:[^\\\/\s'"\x60)\]]+(?: [^\\\/\s'"\x60)\]]+)*[\\\/])*` +
    String.raw`(?:[^\s'"\x60)\]]*[^\s'"\x60)\].,:;])?`,
  'g'
)

/** The error an IM chat receives in place of its answer. */
export function imErrorReply(error: unknown): string {
  // A turn cut off before writing anything is not an error the person can act
  // on; what they can do is tell it to carry on.
  if (error instanceof AppChatTurnInterrupted) return withTurnEndingNote('', { kind: 'interrupted' })
  const folderNote = error instanceof Error ? WORKING_FOLDER_NOTES.get(error.name) : undefined
  if (folderNote) return folderNote
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  // Its explanation names the program to allow, which is for the owner, in Halo.
  if (isRefusedLocalConnection(message)) return REFUSED_LOCAL_CONNECTION_NOTE
  const stripped = message
    .replace(QUOTED_PATH, '$1<local path>$1')
    .replace(BARE_PATH, '$1<local path>')
    .trim()
  if (!stripped) return '⚠️ Error: Unknown error'
  const shown = truncateUtf16Safe(stripped, MAX_ERROR_CHARS)
  return `⚠️ Error: ${shown.length < stripped.length ? `${shown}…` : shown}`
}
