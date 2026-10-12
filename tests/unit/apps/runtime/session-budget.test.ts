/**
 * Session budget: configured maximum (clamped, default 20) halved under system
 * memory pressure, pushed to the engine, lowered budgets trimmed right away (idle
 * sessions only, least recently used first), transient runs make room.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  config: { agent: {} as Record<string, unknown> },
  pressure: 'normal' as 'normal' | 'low' | 'critical',
  configHandlers: [] as Array<(agent: Record<string, unknown>) => void>,
  pressureHandlers: [] as Array<(level: string) => void>,
  resident: [] as Array<{ conversationId: string; spaceId: string; lastUsedAt: number; busy: boolean }>,
  limit: undefined as number | null | undefined,
  evicted: [] as string[],
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => state.config,
  onAgentConfigChange: (handler: (agent: Record<string, unknown>) => void) => {
    state.configHandlers.push(handler)
    return () => { state.configHandlers = state.configHandlers.filter((h) => h !== handler) }
  },
}))
vi.mock('../../../../src/main/platform/background', () => ({
  getSystemMemoryPressure: () => state.pressure,
  onSystemMemoryPressure: (handler: (level: string) => void) => {
    state.pressureHandlers.push(handler)
    return () => { state.pressureHandlers = state.pressureHandlers.filter((h) => h !== handler) }
  },
}))
vi.mock('../../../../src/main/services/agent', () => ({
  listResidentSessions: () => state.resident.map((s) => ({ ...s })),
  setResidentSessionLimit: (limit: number | null) => { state.limit = limit },
  evictIdleSession: (id: string) => {
    const s = state.resident.find((r) => r.conversationId === id)
    if (!s || s.busy) return false
    state.resident = state.resident.filter((r) => r !== s)
    state.evicted.push(id)
    return true
  },
}))

import {
  admitTransientSession,
  computeResidentSessionLimit,
  disposeSessionBudget,
  initSessionBudget,
  releaseTeamEpochSessions,
} from '../../../../src/main/apps/runtime/session-budget'

const session = (id: string, lastUsedAt: number, busy = false) =>
  ({ conversationId: id, spaceId: 's', lastUsedAt, busy })

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  disposeSessionBudget()
  state.config = { agent: {} }
  state.pressure = 'normal'
  state.resident = []
  state.evicted = []
})

describe('computeResidentSessionLimit', () => {
  it.each([
    [undefined, 'normal', 20],
    [undefined, 'low', 10],
    [undefined, 'critical', 10],
    [20, 'normal', 20],
    [20, 'low', 10],
    [7, 'critical', 4],
    [1, 'normal', 2],
    [500, 'normal', 50],
    ['12', 'normal', 20],
    [10, 'normal', 10],
    [10, 'low', 5],
  ] as const)('configured=%s pressure=%s → %d', (configured, pressure, expected) => {
    expect(computeResidentSessionLimit(configured, pressure)).toBe(expected)
  })
})

describe('session budget wiring', () => {
  it('pushes the default limit to the engine on init and clears it on dispose', () => {
    initSessionBudget()
    expect(state.limit).toBe(20)
    disposeSessionBudget()
    expect(state.limit).toBeNull()
  })

  it('halves under memory pressure and trims idle sessions least recently used first', () => {
    state.resident = Array.from({ length: 13 }, (_, i) => session(`c${i}`, i, i === 0))
    initSessionBudget()

    state.pressure = 'low'
    state.pressureHandlers.forEach((h) => h('low'))

    expect(state.limit).toBe(10)
    // c0 is busy and oldest: skipped; the next three oldest idle ones go.
    expect(state.evicted).toEqual(['c1', 'c2', 'c3'])
  })

  it('applies the notified config before it is persisted', () => {
    initSessionBudget()
    state.configHandlers.forEach((h) => h({ maxResidentSessions: 4 }))
    expect(state.config.agent).toEqual({})
    expect(state.limit).toBe(4)
  })

  it('restores the default when an override is removed before persistence', () => {
    state.config = { agent: { maxResidentSessions: 4 } }
    initSessionBudget()
    state.configHandlers.forEach((h) => h({}))
    expect(state.config.agent.maxResidentSessions).toBe(4)
    expect(state.limit).toBe(20)
  })

  it('keeps ten resident chats under system pressure without recycling them', () => {
    state.resident = Array.from({ length: 10 }, (_, i) => session(`c${i}`, i))
    initSessionBudget()
    state.pressure = 'low'
    state.pressureHandlers.forEach((h) => h('low'))
    expect(state.limit).toBe(10)
    expect(state.evicted).toEqual([])
  })

  it('does not evict resident chats for a transient run below the doubled default', () => {
    state.resident = Array.from({ length: 19 }, (_, i) => session(`c${i}`, i))
    initSessionBudget()
    admitTransientSession('run')
    expect(state.limit).toBe(20)
    expect(state.evicted).toEqual([])
  })

  it('a transient run makes room for itself', () => {
    state.config = { agent: { maxResidentSessions: 3 } }
    state.resident = [session('a', 3), session('b', 1), session('c', 2)]
    initSessionBudget()

    admitTransientSession('run-1')

    expect(state.evicted).toEqual(['b'])
  })

  it('never evicts busy sessions to make room', () => {
    state.config = { agent: { maxResidentSessions: 2 } }
    state.resident = [session('a', 1, true), session('b', 2, true)]
    initSessionBudget()

    admitTransientSession('run-2')

    expect(state.evicted).toEqual([])
  })
})

describe('releaseTeamEpochSessions', () => {
  it('closes idle member sessions of exactly the sealed epoch', () => {
    state.resident = [
      session('app-chat:m1:team:t1:e1', 1),
      session('app-chat:m2:team:t1:e1', 2, true),
      session('app-chat:m3:team:t1:e2', 3),
      session('app-chat:m4:team:t2:e1', 4),
      session('space-conversation', 5),
    ]
    expect(releaseTeamEpochSessions('t1', 'e1')).toBe(1)
    expect(state.evicted).toEqual(['app-chat:m1:team:t1:e1'])
  })
})
