import { afterEach, describe, expect, it } from 'vitest'
import { buildTeamSessionKey, type TeamTriggerContext } from '../../../../../src/shared/apps/team-types'
import { forgetEpochTurnOrigins, forgetTurnOrigin, peekTurnOrigin, resolveTurnOrigin } from '../../../../../src/main/apps/runtime/team/external-origin'

const keys = new Set<string>()
const trigger = (external?: boolean, kind: TeamTriggerContext['kind'] = 'message'): TeamTriggerContext => ({ teamId: 'origin-team', epochId: 'epoch', correlationId: 'message', fromAppId: 'sender', wait: false, kind, ...(external ? { external } : {}) })
function key(member: string, epoch = 'epoch', team = 'origin-team'): string {
  const value = buildTeamSessionKey(member, team, epoch)
  keys.add(value)
  return value
}
afterEach(() => { for (const value of keys) forgetTurnOrigin(value); keys.clear() })

describe('external-origin capacity', () => {
  it('never refuses a new external thread at capacity; the least recently used one forgets its origin', () => {
    for (let index = 0; index < 2000; index++) resolveTurnOrigin(key(`member-${index}`), trigger(true))
    expect(resolveTurnOrigin(key('member-0'), trigger(true))).toBe(true)
    expect(resolveTurnOrigin(key('overflow'), trigger(true))).toBe(true)
    expect(peekTurnOrigin(key('member-1'), trigger(undefined, 'periodic_check'))).toBe(false)
    expect(peekTurnOrigin(key('member-0'), trigger(undefined, 'periodic_check'))).toBe(true)
    expect(peekTurnOrigin(key('overflow'), trigger(undefined, 'periodic_check'))).toBe(true)
  })

  it('owner and never-external local work do not consume external capacity', () => {
    for (let index = 0; index < 2200; index++) {
      expect(resolveTurnOrigin(key(`local-${index}`), trigger(undefined, 'human_message'))).toBe(false)
    }
    expect(resolveTurnOrigin(key('external'), trigger(true))).toBe(true)
    expect(peekTurnOrigin(key('never-external'), trigger(undefined, 'periodic_check'))).toBe(false)
  })

  it('permanent epoch cleanup covers removed members while retaining unrelated scopes', () => {
    const removed = key('removed-member')
    const otherEpoch = key('worker', 'other-epoch')
    const otherTeam = key('worker', 'epoch', 'other-team')
    for (const value of [removed, otherEpoch, otherTeam]) resolveTurnOrigin(value, trigger(true))
    forgetEpochTurnOrigins('origin-team', 'epoch')
    expect(peekTurnOrigin(removed, trigger())).toBe(false)
    expect(peekTurnOrigin(otherEpoch, trigger())).toBe(true)
    expect(peekTurnOrigin(otherTeam, trigger())).toBe(true)
  })
})
