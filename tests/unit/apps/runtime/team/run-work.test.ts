import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../../../../src/main/platform/event'
import { buildRunSenderKey } from '../../../../../src/shared/apps/im-keys'
import type { CoordinatorDeliveryRequest } from '../../../../../src/main/apps/runtime/team/space-coordinator'
import type { ExecutionWorkRequest, InputDisposition } from '../../../../../src/main/services/agent'

const state = vi.hoisted(() => ({
  pending: false, request: '', stopped: false, scope: true,
  source: undefined as undefined | (() => any),
  canSpawn: undefined as undefined | (() => boolean),
  stop: vi.fn(async () => {}), release: vi.fn(), releaseRunSource: vi.fn(),
}))
const events = new Emitter<any>()
const work = new Emitter<{ teamId: string; epochId: string }>()
vi.mock('../../../../../src/main/services/agent', () => ({
  onAgentEvent: (listener: (event: any) => void) => events.event(listener),
}))
vi.mock('../../../../../src/main/apps/team', () => ({
  getTeamService: () => ({
    getCollaborationScope: () => state.scope ? { team: { id: 'team' }, epochId: 'epoch' } : undefined,
    participants: {
      beginRequest: (_key: string, id: string) => { state.request = id; state.stopped = false },
      requestAllowed: () => !state.stopped,
      sourceState: () => ({ requestId: state.request, stopped: state.stopped }),
      releaseRunSource: state.releaseRunSource,
      stopSource: state.stop,
    },
  }),
  getTeamStore: () => ({ participants: { getExecution: () => ({ requestId: `${state.request}/member` }) } }),
}))
vi.mock('../../../../../src/main/apps/runtime/team/tool-session', () => ({
  bindSourceToolSession: (_scope: object, callbacks: { source(): unknown; canSpawn(): boolean }) => {
    state.source = callbacks.source
    state.canSpawn = callbacks.canSpawn
    return { server: { name: 'halo-team' }, release: state.release }
  },
}))

import { openRunWork, deliverRunCollaborationSource } from '../../../../../src/main/apps/runtime/team/run-work'

const key = buildRunSenderKey('app', 'run')
const environment = { spaceId: 'space', spacePath: '/storage', workDir: '/work', memoryDir: '/memory' }
const permissions = { granted: [], denied: [] }
const principal = { appId: 'app', permissions, environment }
const runtime = () => ({ hasPendingWork: () => state.pending, onWorkChanged: work.event })

const opened: Array<{ end(): Promise<void> }> = []
function open(overrides: Partial<ExecutionWorkRequest> = {}) {
  let live = true
  const accept = vi.fn(async (_input: unknown, authorized: () => boolean): Promise<InputDisposition> => authorized() ? 'mid_turn' : 'discarded')
  const owned = openRunWork({
    key, principal, modelSelection: { modelSourceId: 'model-source', modelId: 'model' }, requester: undefined, source: { kind: 'run' },
    grants: () => ({ engineId: 'halo', collaborationEnabled: true, mcpServerNames: ['halo-report', 'halo-team'] }),
    isLive: () => live, mayDelegate: () => live, input: { accept }, ...overrides,
  }, { runtime })
  opened.push(owned)
  return { owned, accept, end() { live = false } }
}
function report(overrides: Partial<CoordinatorDeliveryRequest> = {}): CoordinatorDeliveryRequest {
  return {
    conversationId: key, spaceId: 'space', permissionIdentity: 'owner', turnInput: '[Team] evidence',
    persist: { content: 'evidence', metadata: { teamId: 'team', epochId: 'epoch', teamName: 'Reviewers',
      requestId: state.request, fromMemberName: 'reviewer', teamTriggerKind: 'message' } }, ...overrides,
  }
}
afterEach(async () => { for (const owned of opened.splice(0)) await owned.end() })
beforeEach(() => {
  state.pending = false; state.stopped = false; state.scope = true; state.request = ''
  vi.clearAllMocks()
})

describe('run work host', () => {
  it('mounts the collaboration tools and the guidance that describes them', () => {
    const { owned } = open()
    expect(owned.tools).toEqual({ 'halo-team': { name: 'halo-team' } })
    expect(owned.guidance).toContain('independent')
  })

  it('hands an authorized result to the execution with the teammate provenance and reports how it was received', async () => {
    const { owned, accept } = open()
    state.source!()
    expect(await deliverRunCollaborationSource(report())).toEqual({ handled: true, disposition: 'mid_turn' })
    expect(accept).toHaveBeenCalledWith({
      text: '[Team] evidence',
      record: { content: 'evidence', provenance: { source: 'team-message', metadata: expect.objectContaining({ requestId: state.request }) } },
    }, expect.any(Function))
    await owned.end()
  })

  it('rejects mismatched workspace, authority, request and cancelled requests before they reach the execution', async () => {
    const { owned, accept } = open()
    state.source!()
    await deliverRunCollaborationSource(report({ permissionIdentity: 'external' }))
    await deliverRunCollaborationSource(report({ spaceId: 'elsewhere' }))
    const other = report(); other.persist.metadata.requestId = 'unrelated'
    await deliverRunCollaborationSource(other)
    const foreignTeam = report(); foreignTeam.persist.metadata.teamId = 'another'
    await deliverRunCollaborationSource(foreignTeam)
    state.stopped = true
    await deliverRunCollaborationSource(report())
    expect(accept).not.toHaveBeenCalled()
    await owned.end()
  })

  it('lets a result of a nested member through but revokes it at the execution queue once authority is gone', async () => {
    const { owned, accept } = open()
    state.source!()
    const nested = report(); nested.persist.metadata.requestId = `${state.request}/member`
    expect(await deliverRunCollaborationSource(nested)).toEqual({ handled: true, disposition: 'mid_turn' })
    const authorized = accept.mock.calls[0][1] as () => boolean
    expect(authorized()).toBe(true)
    state.stopped = true
    expect(authorized()).toBe(false)
    await owned.end()
  })

  it('reads a late discard as handed over', async () => {
    const { owned, accept } = open()
    state.source!()
    accept.mockResolvedValueOnce('discarded')
    expect(await deliverRunCollaborationSource(report())).toEqual({ handled: true, disposition: 'dispatched' })
    await owned.end()
  })

  it('reports unfinished work from the team runtime and relays its changes', () => {
    const { owned } = open()
    expect(owned.hasPending()).toBe(false)
    state.pending = true
    expect(owned.hasPending()).toBe(true)
    state.scope = false
    expect(owned.hasPending()).toBe(false)
    state.scope = true
    const listener = vi.fn()
    const subscription = owned.onChanged(listener)
    work.fire({ teamId: 'team', epochId: 'epoch' })
    // A private assistant's own range also wakes the run: its end may never reach
    // the parent range as a notice of its own.
    work.fire({ teamId: 'nested', epochId: 'nested-epoch' })
    expect(listener).toHaveBeenCalledTimes(2)
    subscription.dispose()
    work.fire({ teamId: 'team', epochId: 'epoch' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('fails loudly when work is owned but the team runtime is gone', () => {
    const owned = openRunWork({
      key: buildRunSenderKey('app', 'orphan'), principal, requester: undefined, source: { kind: 'run' },
      modelSelection: { modelSourceId: 's', modelId: 'm' }, grants: () => ({ engineId: 'halo', collaborationEnabled: true, mcpServerNames: [] }),
      isLive: () => true, mayDelegate: () => true, input: { accept: async () => 'discarded' },
    }, { runtime: () => null })
    expect(() => owned.hasPending()).toThrow(/runtime is unavailable/)
    expect(owned.onChanged(() => {})).toBeDefined()
    opened.push(owned)
  })

  it('stops descendants once, revokes the endpoint and tools, and refuses late results', async () => {
    const { owned, accept, end } = open()
    state.source!()
    end()
    await Promise.all([owned.end(), owned.end()])
    expect(state.stop).toHaveBeenCalledOnce()
    expect(state.release).toHaveBeenCalledOnce()
    expect(state.releaseRunSource).toHaveBeenCalledOnce()
    await deliverRunCollaborationSource(report())
    expect(accept).not.toHaveBeenCalled()
    expect(await deliverRunCollaborationSource(report({ conversationId: 'ordinary-conversation' }))).toEqual({ handled: false })
  })

  it('creates no request and stops nothing when no collaborator was ever created', async () => {
    const { owned } = open()
    await owned.end()
    expect(state.stop).not.toHaveBeenCalled()
    expect(state.request).toBe('')
  })

  it('hands the captured grants to members and refuses a source once the execution is over', async () => {
    const { owned, end } = open()
    const source = state.source!()
    expect(source).toMatchObject({
      engineId: 'halo', mcpServerNames: ['halo-report', 'halo-team'], sourceAppId: 'app', permissions, environment,
      modelSelection: { modelSourceId: 'model-source', modelId: 'model' },
    })
    end()
    expect(() => state.source!()).toThrow(/no longer available/)
    await owned.end()
  })

  it('accounts only its own local members’ usage, once', async () => {
    const { owned } = open()
    state.source!()
    const tokens = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 7, cacheCreationTokens: 1 }
    // A turn's context gauge is not its consumption: only the result frame counts.
    events.fire({ channel: 'agent:complete', conversationId: 'app-chat:child:team:team:epoch', data: { tokenUsage: tokens } })
    events.fire({ channel: 'agent:complete', conversationId: 'app-chat:child:team:team:epoch', data: { resultUsage: tokens } })
    events.fire({ channel: 'agent:complete', conversationId: 'ordinary-conversation', data: { resultUsage: tokens } })
    events.fire({ channel: 'agent:complete', relayed: true, conversationId: 'app-chat:child:team:team:epoch', data: { resultUsage: tokens } })
    await owned.end()
    expect(owned.takeUsage()).toEqual(tokens)
    expect(owned.takeUsage()).toBeUndefined()
    events.fire({ channel: 'agent:complete', conversationId: 'app-chat:child:team:team:epoch', data: { resultUsage: tokens } })
    expect(owned.takeUsage()).toBeUndefined()
  })

  it('refuses a second live source under the same identity', () => {
    const { owned } = open()
    expect(() => open()).toThrow(/already has an active collaboration source/)
    return owned.end()
  })
})
