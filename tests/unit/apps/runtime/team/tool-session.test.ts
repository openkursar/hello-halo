import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ generation: 1 }))
vi.mock('../../../../../src/main/apps/conversation-mcp', () => ({
  createSpaceTeamMcpServer: (scope: object, source: () => unknown, requestId: () => string) => ({ scope, source, requestId }),
}))
vi.mock('../../../../../src/main/apps/team', () => ({
  getTeamService: () => ({ participants: { sourceGeneration: () => state.generation } }),
  getTeamStore: () => null,
}))
vi.mock('../../../../../src/main/apps/runtime/team/team-tools', () => ({ createTeamMcpServer: () => ({}) }))
vi.mock('../../../../../src/main/apps/runtime/team/source-delivery', () => ({ bindTeamCollaborationSource: () => {} }))

import { bindSourceToolSession } from '../../../../../src/main/apps/runtime/team/tool-session'

const scope = (executionScoped: boolean) => ({
  spaceId: 'space', conversationId: 'conversation', workDir: '/work', executionScoped,
})
const callbacks = (label: string) => ({
  source: () => ({ label }) as any, requestId: () => `request-${label}`, canSpawn: () => true,
})
const endpoint = (binding: { server: unknown }) =>
  binding.server as unknown as { source(): { label: string }; requestId(): string }

beforeEach(() => { state.generation = 1 })

describe('source tool endpoints', () => {
  it('an execution-scoped endpoint stops working once a newer execution binds the same source', () => {
    const first = bindSourceToolSession(scope(true), callbacks('first'))
    expect(endpoint(first).source().label).toBe('first')
    const second = bindSourceToolSession(scope(true), callbacks('second'))
    expect(() => endpoint(first).source()).toThrow(/no longer belongs to an active source turn/)
    expect(() => endpoint(first).requestId()).toThrow(/no longer belongs/)
    expect(endpoint(second).requestId()).toBe('request-second')
  })

  it('a reused conversation endpoint reads the turn in flight, not the one that built it', () => {
    const first = bindSourceToolSession(scope(false), callbacks('first'))
    bindSourceToolSession(scope(false), callbacks('second'))
    expect(endpoint(first).source().label).toBe('second')
  })

  it('releasing a retired endpoint leaves its successor in place; releasing the current one revokes it', () => {
    const first = bindSourceToolSession(scope(true), callbacks('first'))
    const second = bindSourceToolSession(scope(true), callbacks('second'))
    first.release()
    expect(endpoint(second).source().label).toBe('second')
    second.release()
    expect(() => endpoint(second).source()).toThrow(/no longer belongs/)
  })

  it('an endpoint built before the source was stopped never reads the turn that follows the stop', () => {
    const before = bindSourceToolSession(scope(false), callbacks('before'))
    expect(endpoint(before).source().label).toBe('before')
    state.generation = 2
    const after = bindSourceToolSession(scope(false), callbacks('after'))
    expect(() => endpoint(before).source()).toThrow(/no longer belongs/)
    expect(endpoint(after).source().label).toBe('after')
  })
})
