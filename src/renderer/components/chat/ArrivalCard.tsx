/**
 * ArrivalCard — a record received while a reply was being written (see
 * transcript/arrivals), drawn with its own kind's card: as a row of the
 * reply's process, or on its own when the reply has no process to join.
 */

import type { Message } from '../../types'
import { TeamMemberMessage, isTeamMessage } from './team-collab'
import { CrossConversationMessage } from './cross-conversation'

interface ArrivalCardProps {
  message: Message
  /** A line of the reply's work, shaped like the operations around it. */
  inProcess?: boolean
}

export function ArrivalCard({ message, inProcess = false }: ArrivalCardProps) {
  return isTeamMessage(message)
    ? <TeamMemberMessage message={message} inProcess={inProcess} />
    : <CrossConversationMessage message={message} inProcess={inProcess} />
}
