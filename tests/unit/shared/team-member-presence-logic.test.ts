import { describe, it, expect } from 'vitest'
import {
  isRemoteMember,
  shouldShowRelayedTranscript,
  SELF_NODE_ID,
} from '../../../src/shared/apps/team-types'
import { parseTeamSessionKey, buildTeamSessionKey } from '../../../src/shared/apps/im-keys'

// isRemoteMember decision matrix: a member is remote only when it was sourced
// from another node (origin 'remote') AND its owner is not the SELF sentinel.
describe('isRemoteMember', () => {
  it('is true for a federated member owned by another node', () => {
    expect(isRemoteMember({ origin: 'remote', ownerNodeId: 'node-abc' })).toBe(true)
  })

  it('is false for a locally-owned member', () => {
    expect(isRemoteMember({ origin: 'local', ownerNodeId: SELF_NODE_ID })).toBe(false)
  })

  it('is false when origin is remote but the owner is the SELF sentinel', () => {
    // Defensive: an inconsistent row (remote origin yet SELF owner) is treated as
    // local — it is reachable here, so its transcript is locally reloadable.
    expect(isRemoteMember({ origin: 'remote', ownerNodeId: SELF_NODE_ID })).toBe(false)
  })

  it('is false when origin is undefined (legacy/local-only member)', () => {
    expect(isRemoteMember({ ownerNodeId: 'node-abc' })).toBe(false)
  })

  it('is true for a remote member whose ownerNodeId is undefined', () => {
    // origin drives remoteness; undefined !== SELF holds, so it is remote.
    expect(isRemoteMember({ origin: 'remote' })).toBe(true)
  })

  it('is false for an empty member object', () => {
    expect(isRemoteMember({})).toBe(false)
  })
})

// shouldShowRelayedTranscript truth table: the relayed live stream is shown only
// for a remote member, when nothing is actively streaming, when no real (owner-
// served) history has loaded yet, and when some relayed content/thoughts exist.
describe('shouldShowRelayedTranscript', () => {
  const base = {
    isRemote: true,
    hasStreaming: false,
    messageCount: 0,
    streamingContentLength: 0,
    thoughtCount: 0,
  }

  it('is true when remote, idle, no history, and relayed content exists', () => {
    expect(shouldShowRelayedTranscript({ ...base, streamingContentLength: 12 })).toBe(true)
  })

  it('is true when remote, idle, no history, and relayed thoughts exist', () => {
    expect(shouldShowRelayedTranscript({ ...base, thoughtCount: 3 })).toBe(true)
  })

  it('is false for a local member regardless of content', () => {
    expect(
      shouldShowRelayedTranscript({ ...base, isRemote: false, streamingContentLength: 12 }),
    ).toBe(false)
  })

  it('is false while actively streaming (live stream renders instead)', () => {
    expect(
      shouldShowRelayedTranscript({ ...base, hasStreaming: true, streamingContentLength: 12 }),
    ).toBe(false)
  })

  it('is false once owner-served history has populated messages', () => {
    expect(
      shouldShowRelayedTranscript({ ...base, messageCount: 5, streamingContentLength: 12 }),
    ).toBe(false)
  })

  it('is false when there is no relayed content or thoughts', () => {
    expect(shouldShowRelayedTranscript(base)).toBe(false)
  })
})

// On turn-complete with no backend conversation, a session is preserved iff it
// is a team-overlay session whose member is remote. This mirrors the runtime
// decision `!!parseTeamSessionKey(id) && isRemoteMember(member)`.
describe('B-1 remote team-session preserve-on-complete decision', () => {
  const remoteMember = { origin: 'remote' as const, ownerNodeId: 'node-xyz' }
  const localMember = { origin: 'local' as const, ownerNodeId: SELF_NODE_ID }

  function shouldPreserveRelayed(
    conversationId: string,
    member: { origin?: 'local' | 'remote'; ownerNodeId?: string } | undefined,
  ): boolean {
    const teamSession = parseTeamSessionKey(conversationId)
    if (!teamSession || !member) return false
    return isRemoteMember(member)
  }

  const teamKey = buildTeamSessionKey('app-1', 'team-1', 'epoch-1')

  it('preserves a team-overlay session for a remote member', () => {
    expect(shouldPreserveRelayed(teamKey, remoteMember)).toBe(true)
  })

  it('clears a team-overlay session for a local member', () => {
    expect(shouldPreserveRelayed(teamKey, localMember)).toBe(false)
  })

  it('clears a plain (non-team) app-chat session even for a remote member', () => {
    expect(shouldPreserveRelayed('app-chat:app-1', remoteMember)).toBe(false)
  })

  it('clears when the member cannot be resolved', () => {
    expect(shouldPreserveRelayed(teamKey, undefined)).toBe(false)
  })
})
