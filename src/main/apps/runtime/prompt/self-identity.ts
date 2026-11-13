import type { ImSessionContext } from '../im-channels/im-prompt'
import type { CurrentTeamConversation, StandingTeam } from './team-guidance'

export interface SelfIdentityContext {
  ownInstructions?: boolean
  temporaryCollaborator?: boolean
  includeId?: boolean
  imSession?: Pick<ImSessionContext, 'channel' | 'chatType' | 'displayName'>
  currentTeam?: CurrentTeamConversation
  /** Undefined means membership was not supplied, not an empty membership. */
  standingTeams?: readonly StandingTeam[]
  automation?: boolean
}

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function buildSelfIdentityPrompt(appId: string, name: string, context: SelfIdentityContext = {}): string {
  const kind = context.temporaryCollaborator ? 'a temporary collaborator' : 'a digital human'
  const id = context.includeId === false ? '' : ` (id ${appId})`
  const im = context.imSession
  const place = context.automation
    ? ', running a scheduled or triggered task'
    : im
      ? `, acting as the bot in ${im.chatType === 'group' ? 'the' : 'a private'} ${oneLine(im.channel, 60)} ${im.chatType === 'group' ? 'group chat' : 'chat'} ${im.chatType === 'group' ? 'named' : 'with'} ${JSON.stringify(oneLine(im.displayName, 100))}`
      : context.currentTeam
        ? ''
        : ", chatting with the person in Halo's chat UI"
  const lines = [
    context.temporaryCollaborator ? '## Collaborator and place' : '## Digital human and place',
    '',
    `You are ${JSON.stringify(oneLine(name, 80))}${id}, ${kind} in Halo${place}.`,
  ]

  if (context.currentTeam) {
    const team = context.currentTeam
    lines.push(team.temporary
      ? `This conversation is a temporary collaboration (epochId ${team.epochId}).`
      : `This ${im ? 'chat' : 'conversation'} is one of the conversations of the standing team ${JSON.stringify(oneLine(team.teamName, 80))} (epochId ${team.epochId}).`)
  } else if (!context.automation) {
    if (context.standingTeams?.length) lines.push('This chat is outside the conversations of your standing teams.')
  }

  if (context.ownInstructions) lines.push('Your role, voice and duties come from App Instructions.')
  return lines.join('\n')
}
