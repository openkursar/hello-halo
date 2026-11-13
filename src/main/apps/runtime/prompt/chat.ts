import { assembleAppChatPrompt } from './assembler'
import { buildIdentityFragments, type IdentityFragmentsInput } from './identity'
import { buildSelfIdentityPrompt } from './self-identity'
import { buildTeamGuidance, type CurrentTeamConversation, type StandingTeam } from './team-guidance'
import { NATIVE_CHAT_ENTRY } from './entry-native'
import { buildImEntry, buildImConstraints, type ImSessionContext, type ImNotifyContext } from '../im-channels/im-prompt'
import { buildTeamEntry, buildTeamConstraints, buildTeamImBridge, type TeamPromptContext } from '../team/team-prompt'

export interface DigitalHumanChatPromptInput extends IdentityFragmentsInput {
  appName: string
  includeAppId: boolean
  standingTeams: readonly StandingTeam[] | undefined
  imSession?: ImSessionContext
  ownerIds?: string[]
  notifications?: ImNotifyContext
  team?: { context: TeamPromptContext; conversation: CurrentTeamConversation }
  collaborationGuide?: string
}

/** Composition only: callers supply authorized facts and mounted capabilities. */
export function buildDigitalHumanChatPrompt(input: DigitalHumanChatPromptInput): string {
  const identity = buildIdentityFragments(input)
  const team = input.team
  identity.push(buildSelfIdentityPrompt(input.appId, input.appName, {
    ownInstructions: input.appSpec.type === 'automation' && !!input.appSpec.system_prompt,
    temporaryCollaborator: team?.context.selfIsDisposable,
    includeId: input.includeAppId,
    imSession: input.imSession,
    currentTeam: team?.conversation,
    standingTeams: input.standingTeams,
  }))
  const teams = buildTeamGuidance({
    teams: input.standingTeams,
    current: team?.conversation,
    collaborationAvailable: !!input.collaborationGuide,
  })
  if (teams) identity.push(teams)

  const entry: string[] = []
  const constraints: string[] = []
  if (input.collaborationGuide) entry.push(`## Collaboration\n\n${input.collaborationGuide}`)
  if (team) {
    entry.push(buildTeamEntry(team.context))
    if (input.imSession) entry.push(buildTeamImBridge(input.imSession, team.context.selfIsLead))
    constraints.push(...buildTeamConstraints(team.context))
  }
  if (input.imSession) {
    entry.push(buildImEntry(input.imSession, input.ownerIds, input.notifications))
    constraints.push(...buildImConstraints(input.imSession, input.ownerIds))
  } else {
    entry.push(NATIVE_CHAT_ENTRY)
  }
  return assembleAppChatPrompt({ identity, entry: entry.join('\n\n'), constraints })
}
