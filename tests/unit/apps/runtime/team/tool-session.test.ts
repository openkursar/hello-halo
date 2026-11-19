import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ generation: 1, work: null as any, bindSource: vi.fn() }))
vi.mock('../../../../../src/main/apps/conversation-mcp', () => ({
  createSpaceTeamMcpServer: (scope: object, source: () => unknown, requestId: () => string) => ({ scope, source, requestId }),
}))
vi.mock('../../../../../src/main/apps/team', () => ({
  getTeamService: () => ({ participants: { sourceGeneration: () => state.generation }, getCollaborationScope: () => state.work }),
  getTeamStore: () => null,
}))
vi.mock('../../../../../src/main/apps/runtime/team/team-tools', () => ({ createTeamMcpServer: (context: unknown) => ({ context }) }))
vi.mock('../../../../../src/main/apps/runtime/team/source-delivery', () => ({ bindTeamCollaborationSource: state.bindSource }))

import { bindTeamToolSession, bindSourceToolSession } from '../../../../../src/main/apps/runtime/team/tool-session'

const scope = (executionScoped: boolean) => ({
  spaceId: 'space', conversationId: 'conversation', workDir: '/work', executionScoped,
})
const callbacks = (label: string) => ({
  source: () => ({ label }) as any, requestId: () => `request-${label}`, canSpawn: () => true,
})
const endpoint = (binding: { server: unknown }) =>
  binding.server as unknown as { source(): { label: string }; requestId(): string }

beforeEach(() => { state.generation = 1; state.work = null; state.bindSource.mockClear() })

it('reads only an existing private collaboration without registering delivery and rejects a released endpoint', () => {
  const context = { participants: { registerSource: vi.fn(), generation: () => '1', capture: () => () => {}, requestId: () => 'request' } } as any
  const binding = bindTeamToolSession('private-parent', context)
  expect(context.privateAssistants.readContext()).toBeNull()
  state.work = { team: { id: 'private-team' }, epochId: 'private-epoch' }
  expect(context.privateAssistants.readContext()).toMatchObject({ teamId: 'private-team', epochId: 'private-epoch', selfIsLead: true })
  expect(state.bindSource).not.toHaveBeenCalled()
  expect(context.participants.registerSource).toHaveBeenCalledTimes(1)
  binding.release()
  expect(() => context.privateAssistants.readContext()).toThrow(/no longer belongs/)
})

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

  it('a reused endpoint captures the current direct parent reasoning without evaluating the source', () => {
    const firstContext = { selection: { modelSourceId: 'a', modelId: 'first' }, engineId: 'halo' as const,
      reasoning: { version: 1 as const, mode: 'off' as const } }
    const secondContext = { selection: { modelSourceId: 'b', modelId: 'second' }, engineId: 'halo' as const,
      reasoning: { version: 1 as const, mode: 'budget' as const, budgetTokens: 8192 } }
    const first = bindSourceToolSession({ ...scope(false), modelContext: () => firstContext }, callbacks('first'))
    const source = vi.fn(callbacks('second').source)
    bindSourceToolSession({ ...scope(false), modelContext: () => secondContext }, { ...callbacks('second'), source })
    const server = first.server as unknown as { scope: { modelContext(): unknown } }
    expect(server.scope.modelContext()).toEqual(secondContext)
    expect(source).not.toHaveBeenCalled()
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
