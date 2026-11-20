/**
 * A record received while a reply was being written (see transcript/arrivals):
 * ArrivalCard draws it in the reply's process; a reply with no process draws
 * them after it (TrailingArrivals), a team's messages as the received line and
 * other kinds as their own cards.
 */

import type { Message } from '../../types'
import { ReplyOpeners, TeamMemberMessage, isTeamMessage } from './team-collab'
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

interface TrailingArrivalsProps {
  arrivals: readonly Message[]
  senderName?: string
  /** Space above a team's line; the default leaves room for the reply's hover actions. */
  lineGapClassName?: string
}

export function TrailingArrivals({ arrivals, senderName, lineGapClassName = 'mt-8' }: TrailingArrivalsProps) {
  const runs: Message[][] = []
  for (const message of arrivals) {
    const run = runs[runs.length - 1]
    if (run && isTeamMessage(run[0]) && isTeamMessage(message) && run[0].metadata?.teamId === message.metadata?.teamId) run.push(message)
    else runs.push([message])
  }
  return (
    <>
      {runs.map(run => {
        const key = run[0].clientKey ?? run[0].id
        return isTeamMessage(run[0])
          ? <div key={key} className={lineGapClassName}><ReplyOpeners senderName={senderName} openers={run} /></div>
          : <div key={key} className="mt-3"><CrossConversationMessage message={run[0]} /></div>
      })}
    </>
  )
}
