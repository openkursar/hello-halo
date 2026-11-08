/**
 * What the app keeps of the router's reports about which model of a group
 * serves a conversation, and how a conversation finds its own.
 */

import { describe, expect, it } from 'vitest'
import { MAX_GROUP_ROUTES, mergeGroupRoutes, pickGroupRoute } from '../../../src/renderer/utils/group-routes'
import type { GroupRouteInfo } from '../../../src/shared/types/ai-groups-runtime'

function report(sessionKey: string, at: number, extra: Partial<GroupRouteInfo> = {}): GroupRouteInfo {
  return {
    groupId: 'g1', sessionKey, state: 'serving', at,
    member: { key: 'a\u0000m', sourceId: 'a', modelId: 'm', label: { account: 'A', model: 'M' } },
    ...extra,
  }
}

describe('mergeGroupRoutes', () => {
  it('adds a report for a conversation it has not heard of', () => {
    const merged = mergeGroupRoutes({}, [report('c1', 10)])
    expect(merged.c1.at).toBe(10)
  })

  it('keeps the newer report of a conversation', () => {
    const merged = mergeGroupRoutes({ c1: report('c1', 20) }, [report('c1', 10, { state: 'exhausted' })])
    expect(merged.c1).toMatchObject({ at: 20, state: 'serving' })
    expect(mergeGroupRoutes(merged, [report('c1', 30, { state: 'switching' })]).c1.state).toBe('switching')
  })

  it('lets a later report of the same instant win, since the router can say two things in one millisecond', () => {
    const merged = mergeGroupRoutes({ c1: report('c1', 10, { state: 'switching' }) }, [report('c1', 10)])
    expect(merged.c1.state).toBe('serving')
  })

  it('hands back the very same object when nothing changed, so a store need not notify', () => {
    const current = { c1: report('c1', 10) }
    expect(mergeGroupRoutes(current, [])).toBe(current)
    expect(mergeGroupRoutes(current, [report('c1', 10)])).toBe(current)
    expect(mergeGroupRoutes(current, [report('c1', 5)])).toBe(current)
  })

  it('does not change what it was given', () => {
    const current = { c1: report('c1', 10) }
    mergeGroupRoutes(current, [report('c2', 20)])
    expect(Object.keys(current)).toEqual(['c1'])
  })

  it('forgets the oldest reports past its limit', () => {
    const many = Array.from({ length: MAX_GROUP_ROUTES + 5 }, (_, index) => report(`c${index}`, index + 1))
    const merged = mergeGroupRoutes({}, many)
    expect(Object.keys(merged)).toHaveLength(MAX_GROUP_ROUTES)
    expect(merged.c0).toBeUndefined()
    expect(merged.c4).toBeUndefined()
    expect(merged.c5).toBeDefined()
    expect(merged[`c${MAX_GROUP_ROUTES + 4}`]).toBeDefined()
  })
})

describe('pickGroupRoute', () => {
  const routes = {
    c1: report('c1', 10),
    s1: report('s1', 20),
    other: report('other', 30, { groupId: 'g2' }),
  }

  it('finds a conversation by its own id', () => {
    expect(pickGroupRoute(routes, 'g1', ['c1'])?.at).toBe(10)
  })

  it('finds it by the engine session id as well, and prefers the later report', () => {
    expect(pickGroupRoute(routes, 'g1', ['c1', 's1'])?.at).toBe(20)
    expect(pickGroupRoute(routes, 'g1', [undefined, 's1'])?.at).toBe(20)
  })

  it('ignores a report from a group the conversation has since left', () => {
    expect(pickGroupRoute(routes, 'g1', ['other'])).toBeNull()
    expect(pickGroupRoute(routes, 'g2', ['other'])?.at).toBe(30)
  })

  it('knows nothing of a conversation the router has not served', () => {
    expect(pickGroupRoute(routes, 'g1', ['unknown', undefined])).toBeNull()
  })
})
