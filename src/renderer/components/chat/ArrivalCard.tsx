/**
 * ArrivalCard — a record received while a reply was being written (see
 * transcript/arrivals), drawn with its own kind's card: as a row of the
 * reply's process, or on its own when the reply has no process to join.
 */

import { Send, Users } from 'lucide-react'
import type { Message } from '../../types'
import { TeamMemberMessage, isTeamMessage } from './team-collab'
import { CrossConversationMessage } from './cross-conversation'

interface ArrivalCardProps {
  message: Message
  inProcess?: boolean
  /** Row of the live process timeline, which already draws the kind icon and the spacing. */
  timeline?: boolean
}

export function ArrivalCard({ message, inProcess = false, timeline = false }: ArrivalCardProps) {
  return isTeamMessage(message)
    ? <TeamMemberMessage message={message} inProcess={inProcess} timeline={timeline} />
    : <CrossConversationMessage message={message} inProcess={inProcess} timeline={timeline} />
}

/** Icon the live process timeline shows for an arrival of this kind. */
export function arrivalIcon(message: Message): typeof Users {
  return isTeamMessage(message) ? Users : Send
}
