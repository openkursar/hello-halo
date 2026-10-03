/**
 * Local team-member history rows carry seq (1-based ordinal) and honor
 * sinceSeq, matching the owner-side federation serialization.
 */

import { describe, it, expect, vi } from 'vitest'

const messages = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }))
vi.mock('../../../../src/main/apps/runtime/session-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readSessionMessages: () => messages.value,
}))
vi.mock('../../../../src/main/apps/manager', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAppManager: () => ({ getApp: () => ({ spaceId: 's1' }) }),
}))
vi.mock('../../../../src/main/services/space.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSpace: () => ({ path: '/tmp/space' }),
}))

const { readTeamMemberHistory } = await import('../../../../src/main/apps/runtime/app-chat')

describe('readTeamMemberHistory', () => {
  it('stamps seq and returns only the tail after sinceSeq', () => {
    messages.value = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(readTeamMemberHistory('app', 'team', 'epoch').map(r => r.seq)).toEqual([1, 2, 3])
    expect(readTeamMemberHistory('app', 'team', 'epoch', 2)).toEqual([{ id: 'c', seq: 3 }])
    expect(readTeamMemberHistory('app', 'team', 'epoch', 3)).toEqual([])
  })
})
