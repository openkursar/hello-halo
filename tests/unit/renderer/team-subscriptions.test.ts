import { afterEach, expect, it, vi } from 'vitest'
const fixtures = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], subscribe: vi.fn(), unsubscribe: vi.fn(), history: vi.fn(), listener: undefined as undefined | ((event: unknown) => void) }))
vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => fixtures.effects.push(effect),
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
}))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => false, subscribeToConversation: fixtures.subscribe, unsubscribeFromConversation: fixtures.unsubscribe }))
vi.mock('../../../src/renderer/api', () => ({ api: { teamChatMessages: fixtures.history, onTeamMemberHistory: (listener: (event: unknown) => void) => { fixtures.listener = listener; return () => { fixtures.listener = undefined } } } }))
import { useRemoteSubscription } from '../../../src/renderer/hooks/useRemoteSubscription'
import { useTaskReports } from '../../../src/renderer/components/team/workbench/useTaskReports'
import type { RosterMember } from '../../../src/shared/apps/team-types'
afterEach(() => { fixtures.effects.length = 0; vi.clearAllMocks() })
it('keeps one remote subscription until both surfaces unmount', () => {
  useRemoteSubscription('session')
  useRemoteSubscription('session')
  const first = fixtures.effects[0]() as () => void
  const second = fixtures.effects[1]() as () => void
  expect(fixtures.subscribe).toHaveBeenCalledTimes(1)
  first()
  expect(fixtures.unsubscribe).not.toHaveBeenCalled()
  second()
  expect(fixtures.unsubscribe).toHaveBeenCalledTimes(1)
  expect(fixtures.unsubscribe).toHaveBeenCalledWith('session')
})
it('loads member reports at concurrency three and ignores another epoch', async () => {
  const pending: (() => void)[] = []
  let active = 0
  let maximum = 0
  fixtures.history.mockImplementation(() => new Promise(resolve => {
    active++
    maximum = Math.max(maximum, active)
    pending.push(() => { active--; resolve({ success: true, data: [] }) })
  }))
  const roster = Array.from({ length: 7 }, (_, i) => ({ appId: `a${i}`, memberName: `Member ${i}`, spaceId: 's' })) as RosterMember[]
  useTaskReports('t', 'e', roster, 0)
  const cleanup = fixtures.effects[0]() as () => void
  await Promise.resolve()
  expect(fixtures.history).toHaveBeenCalledTimes(3)
  while (pending.length) {
    pending.shift()!()
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  expect(fixtures.history).toHaveBeenCalledTimes(7)
  expect(maximum).toBe(3)
  fixtures.listener?.({ teamId: 't', epochId: 'other', appId: 'a0' })
  expect(fixtures.history).toHaveBeenCalledTimes(7)
  cleanup()
  expect(fixtures.listener).toBeUndefined()
})
it('does not read team reports while the drawer is showing one member execution', async () => {
  useTaskReports('t', 'e', [], 0)
  const cleanup = fixtures.effects[0]() as () => void
  await Promise.resolve()
  fixtures.listener?.({ teamId: 't', epochId: 'e', appId: 'another-member' })
  expect(fixtures.history).not.toHaveBeenCalled()
  cleanup()
})
