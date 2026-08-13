/**
 * A periodic check belongs to the piece of work it was set inside.
 *
 * `TeamDetail.checks` spans the whole office, so any surface bound to a single
 * run or conversation has to narrow by epoch as well as by member. Getting this
 * wrong shows a member checks that are not running here — and offers a Stop
 * button for them.
 */

import { describe, it, expect } from 'vitest'
import { checksForMember } from '../../../src/shared/apps/team-types'
import type { TeamCheckView } from '../../../src/shared/apps/team-types'

function check(id: string, targetAppId: string, epochId: string): TeamCheckView {
  return {
    id,
    epochId,
    targetAppId,
    targetMemberName: 'bugfixer',
    createdByMemberName: 'reviewer',
    instruction: 'Look for open bugs.',
    schedule: { kind: 'every', every: '30m' },
    runCount: 0,
    lastRunAt: null,
    reachable: true,
  }
}

const ALL = [
  check('c1', 'app-a', 'epoch-1'),
  check('c2', 'app-a', 'epoch-2'),
  check('c3', 'app-b', 'epoch-1'),
]

describe('checksForMember', () => {
  it('narrows to one member inside one piece of work', () => {
    expect(checksForMember(ALL, 'app-a', 'epoch-1').map((c) => c.id)).toEqual(['c1'])
  })

  it('excludes the same member’s checks from another piece of work', () => {
    expect(checksForMember(ALL, 'app-a', 'epoch-2').map((c) => c.id)).toEqual(['c2'])
    expect(checksForMember(ALL, 'app-a', 'epoch-3')).toEqual([])
  })

  it('keeps every piece of work when no epoch is given', () => {
    // The team-wide member screen, and a floor with nothing focused.
    expect(checksForMember(ALL, 'app-a').map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(checksForMember(ALL, 'app-a', null).map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('returns nothing for a member with no checks', () => {
    expect(checksForMember(ALL, 'app-c', 'epoch-1')).toEqual([])
    expect(checksForMember([], 'app-a')).toEqual([])
  })
})
