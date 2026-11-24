/**
 * ArrivalCard — a record received while a reply was being written (see
 * transcript/arrivals), drawn with its own kind's card: as a row of the
 * reply's process, or on its own when the reply has no process to join.
 */

import { memo } from 'react'
import type { Message } from '../../types'
import { TeamMemberMessage, isTeamMessage } from './team-collab'
import { CrossConversationMessage } from './cross-conversation'

interface ArrivalCardProps {
  message: Message
  /** A line of the reply's work, shaped like the operations around it. */
  inProcess?: boolean
}

/** Drawn under a reply that re-renders with every streamed word; a stored record does not change. */
export const ArrivalCard = memo(function ArrivalCard({ message, inProcess = false }: ArrivalCardProps) {
  return isTeamMessage(message)
    ? <TeamMemberMessage message={message} inProcess={inProcess} />
    : <CrossConversationMessage message={message} inProcess={inProcess} />
})
