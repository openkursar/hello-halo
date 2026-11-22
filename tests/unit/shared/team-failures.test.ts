import { describe, expect, it } from 'vitest'
import type { TeamActivity } from '../../../src/shared/apps/team-types'
import { openMemberFailures } from '../../../src/shared/apps/team-failures'

const act = (id: string, patch: Partial<TeamActivity>) => ({
  id, teamId: 't', epochId: 'e', kind: 'message', actorAppId: 'lead', targetAppId: null, subject: '', body: null, refId: null, correlationId: null, status: null, createdAt: 0, ...patch,
}) as unknown as TeamActivity

describe('openMemberFailures', () => {
  const lost = act('lost', { kind: 'reply', actorAppId: 'tester', targetAppId: 'design', status: 'undelivered', createdAt: 10 })

  it('files a message that never arrived under its recipient, even after the sender moved on', () => {
    const later = act('later', { actorAppId: 'design', targetAppId: 'lead', createdAt: 20 })
    expect([...openMemberFailures([lost, later], new Set()).values()]).toEqual([{ appId: 'tester', activityId: 'lost', senderAppId: 'design' }])
  })

  it('clears once the member acts again or is at work', () => {
    expect(openMemberFailures([lost, act('back', { actorAppId: 'tester', createdAt: 20 })], new Set()).size).toBe(0)
    expect(openMemberFailures([lost], new Set(['tester'])).size).toBe(0)
  })

  it('reads a failed turn as its engine error, newest failure first', () => {
    const turn = act('turn', { kind: 'reply', actorAppId: 'writer', status: 'error', subject: 'The member’s turn failed: 429 rate limit', createdAt: 30 })
    const failures = [...openMemberFailures([lost, turn], new Set()).values()]
    expect(failures.map(failure => failure.appId)).toEqual(['writer', 'tester'])
    expect(failures[0]).toEqual({ appId: 'writer', activityId: 'turn', reason: '429 rate limit' })
  })
})
