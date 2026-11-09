import { isSpaceConversationId, parseNativeChatKey } from '../../../src/shared/apps/im-keys'

export interface SourceTurn { conversationId: string; spaceId: string; completed: boolean }
export interface StoredInput {
  role: string
  content: string
  timestamp: string
  source?: string
  metadata?: { source?: string; teamTriggerKind?: string }
}
export type SourceTarget = Pick<SourceTurn, 'conversationId' | 'spaceId'>

/** The workspace composer can address a space chat or a native digital-human chat. */
export function sourceTurnCandidates(turns: readonly SourceTurn[], expected?: SourceTarget): SourceTurn[] {
  const candidates = new Map<string, SourceTurn>()
  for (const turn of turns) {
    if (!isSpaceConversationId(turn.conversationId) && !parseNativeChatKey(turn.conversationId)) continue
    if (expected && (turn.conversationId !== expected.conversationId || turn.spaceId !== expected.spaceId)) continue
    const key = JSON.stringify([turn.spaceId, turn.conversationId])
    // Several starts can belong to the same source; event order never chooses between identities.
    if (!candidates.has(key)) candidates.set(key, turn)
  }
  return [...candidates.values()]
}

/** Correlate the click to its new durable human input, not to a background report quoting it. */
export function matchesSubmittedInput(messages: readonly StoredInput[], text: string, armedAt: number): boolean {
  return messages.some(message => message.role === 'user'
    && message.content === text
    && Number.isFinite(Date.parse(message.timestamp)) && Date.parse(message.timestamp) >= armedAt
    && !message.source && !message.metadata?.source
    && (!message.metadata?.teamTriggerKind || message.metadata.teamTriggerKind === 'human_message'))
}

export function selectSubmittedSource(matches: readonly SourceTurn[]): SourceTurn | undefined {
  if (matches.length > 1) {
    throw new Error(`The UI submission matched multiple source conversations; specify its expected target: ${matches.map(match => match.conversationId).join(', ')}`)
  }
  return matches[0]
}
