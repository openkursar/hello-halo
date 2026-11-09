/**
 * What the app tells a person about which model a conversation is on: only
 * the changes worth noticing, never every request.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupRouteState } from '../../../../src/main/services/ai-sources/group-route-state'
import type { GroupRouteFact, GroupRouteMember } from '../../../../src/main/openai-compat-router'
import type { GroupRouteInfo } from '../../../../src/shared/types/ai-groups-runtime'

const member = (id: string): GroupRouteMember => ({
  key: `${id}\u0000m`, sourceId: id, modelId: 'm', label: { account: `Account ${id}`, model: 'Model' },
})
const A = member('a')
const B = member('b')

let state: GroupRouteState
let heard: GroupRouteInfo[]
let at: number

const fact = (extra: Partial<GroupRouteFact>): GroupRouteFact =>
  ({ groupId: 'g', sessionKey: 'conv-1', phase: 'served', at: ++at, ...extra })

beforeEach(() => {
  state = new GroupRouteState()
  heard = []
  at = 0
  state.onChange(info => heard.push(info))
})

describe('following a conversation', () => {
  it('tells when a model begins to serve it, and says nothing while that model keeps serving', () => {
    state.record(fact({ member: A, attempt: 1 }))
    state.record(fact({ member: A, attempt: 1 }))
    state.record(fact({ member: A, attempt: 1 }))
    expect(heard).toEqual([{ groupId: 'g', sessionKey: 'conv-1', state: 'serving', member: A, at: 1 }])
  })

  it('does not announce an ordinary first attempt', () => {
    state.record(fact({ phase: 'trying', member: A, attempt: 1 }))
    expect(heard).toEqual([])
    expect(state.get(['conv-1'])).toEqual([])
  })

  it('shows a switch while it happens, then the model that took over', () => {
    state.record(fact({ member: A, attempt: 1 }))
    state.record(fact({ phase: 'trying', member: B, attempt: 2, previous: { member: A, reason: 'is limiting requests' } }))
    state.record(fact({ member: B, attempt: 2 }))
    expect(heard.map(info => [info.state, info.member?.sourceId])).toEqual([['serving', 'a'], ['switching', 'b'], ['serving', 'b']])
    expect(heard[1].previous).toEqual({ member: A, reason: 'is limiting requests' })
    expect(state.get(['conv-1'])[0]).toMatchObject({ state: 'serving', member: B })
  })

  it('tells when a group has nothing left to try', () => {
    state.record(fact({ member: A, attempt: 1 }))
    state.record(fact({ phase: 'exhausted', attempt: 3 }))
    expect(heard.at(-1)).toMatchObject({ state: 'exhausted' })
    expect(heard.at(-1)).not.toHaveProperty('member')
  })

  it('announces a return to a model after another served', () => {
    state.record(fact({ member: A, attempt: 1 }))
    state.record(fact({ member: B, attempt: 2 }))
    state.record(fact({ member: A, attempt: 1 }))
    expect(heard.map(info => info.member?.sourceId)).toEqual(['a', 'b', 'a'])
  })

  it('announces the same model again when it serves for another group', () => {
    state.record(fact({ member: A, attempt: 1 }))
    state.record(fact({ member: A, attempt: 1, groupId: 'other' }))
    expect(heard.map(info => info.groupId)).toEqual(['g', 'other'])
  })

  it('cannot follow a request that names no conversation', () => {
    state.record(fact({ sessionKey: null, member: A, attempt: 1 }))
    expect(heard).toEqual([])
  })
})

describe('asking where conversations are', () => {
  it('answers for the conversations it knows and skips the rest', () => {
    state.record(fact({ sessionKey: 'one', member: A, attempt: 1 }))
    state.record(fact({ sessionKey: 'two', member: B, attempt: 1 }))
    expect(state.get(['two', 'unknown', 'one']).map(info => info.sessionKey)).toEqual(['two', 'one'])
    expect(state.get([])).toEqual([])
  })

  it('keeps the latest word, even for a quiet change in time', () => {
    state.record(fact({ member: A, attempt: 1 }))
    const quiet = vi.fn()
    state.onChange(quiet)
    state.record(fact({ member: A, attempt: 1 }))
    expect(quiet).not.toHaveBeenCalled()
    expect(state.get(['conv-1'])[0].at).toBe(2)
  })

  it('forgets the oldest conversations beyond its bound', () => {
    for (let i = 0; i < 520; i++) state.record(fact({ sessionKey: `c${i}`, member: A, attempt: 1 }))
    expect(state.get(['c0', 'c1'])).toEqual([])
    expect(state.get(['c519'])).toHaveLength(1)
  })
})
