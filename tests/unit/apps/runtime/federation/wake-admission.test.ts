import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFederationCoordinator } from '../../../../../src/main/apps/runtime/federation/coordinator'
import type { FederationCoordinator } from '../../../../../src/main/apps/runtime/federation/coordinator'
import type { FederationMessage, SerializedWakeRequest, WakeFrame } from '../../../../../src/main/apps/runtime/federation/types'
import type { FederationLink } from '../../../../../src/main/apps/runtime/federation/link'
import type { TeamStore } from '../../../../../src/main/apps/team'
import type { FederationStore } from '../../../../../src/main/apps/runtime/federation/deps'
import { buildTeamSessionKey, SELF_NODE_ID } from '../../../../../src/shared/apps/team-types'

const OFFICE = 'narrow-office'
const WIDE = 'wide-office'
const HOST = 'host'
const PEER = 'peer'
const OTHER = 'other-peer'
const TARGET = 'shared-app'
const EPOCH = 'narrow-epoch'
const active: FederationCoordinator[] = []

function harness(selfNode = HOST, authorityNode = HOST) {
  const members = new Map<string, { appId: string; ownerNodeId: string }>([
    [TARGET, { appId: TARGET, ownerNodeId: SELF_NODE_ID }],
    ['peer-app', { appId: 'peer-app', ownerNodeId: PEER }],
    ['other-app', { appId: 'other-app', ownerNodeId: OTHER }],
  ])
  const epochs = new Map<string, { id: string; teamId: string }>([
    [EPOCH, { id: EPOCH, teamId: OFFICE }], ['wide-epoch', { id: 'wide-epoch', teamId: WIDE }],
  ])
  const store = {
    getTeamById: () => ({ id: OFFICE, hostNodeId: authorityNode, leadAppId: TARGET }),
    getMember: (teamId: string, appId: string) => teamId === OFFICE ? members.get(appId) ?? null : null,
    getEpochById: (epochId: string) => epochs.get(epochId) ?? null,
    listMembersByTeam: () => [...members.values()],
  } as unknown as TeamStore
  let receive: (from: string, message: FederationMessage) => void = () => {}
  const send = vi.fn()
  const link: FederationLink = { send, broadcast: () => {}, onMessage: handler => { receive = handler }, close: () => {} }
  const run = vi.fn(async (request: SerializedWakeRequest) => ({ finalMessage: `result:${request.message}` }))
  const coordinator = createFederationCoordinator({
    context: { officeId: OFFICE, selfNodeId: selfNode }, link,
    federationStore: { listNodesByOffice: () => [] } as unknown as FederationStore,
    teamStore: store, verifyCredential: () => null, getWakeAuthority: () => authorityNode,
    onWake: run, wakeAdmissionTimeoutMs: 1000,
    presence: { heartbeatIntervalMs: 60000, suspectAfterMs: 120000, confirmedOfflineMs: 240000 },
  })
  coordinator.start()
  active.push(coordinator)
  const wake = (patch: Partial<SerializedWakeRequest> = {}, correlationId = 'request'): WakeFrame => ({
    kind: 'wake', officeId: OFFICE, correlationId, fromNode: PEER,
    request: { appId: TARGET, spaceId: 'ignored-peer-space', message: 'work',
      conversationId: buildTeamSessionKey(TARGET, OFFICE, EPOCH),
      teamContext: { teamId: OFFICE, epochId: EPOCH, correlationId, fromAppId: 'peer-app', wait: true, kind: 'message' },
      ...patch },
  })
  return { members, epochs, run, send, coordinator, wake,
    deliver: (frame: WakeFrame, from = PEER) => receive(from, frame),
    setAuthority: (nodeId: string) => { authorityNode = nodeId } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const coordinator of active.splice(0)) coordinator.stop(); vi.useRealTimers() })

describe('authenticated wake admission', () => {
  it('refuses selection of a different office policy even for an app in both offices', () => {
    const h = harness()
    const frame = h.wake()
    frame.request.teamContext.teamId = WIDE
    frame.request.teamContext.epochId = 'wide-epoch'
    frame.request.conversationId = buildTeamSessionKey(TARGET, WIDE, 'wide-epoch')
    h.deliver(frame)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith(PEER, expect.objectContaining({ outcome: { kind: 'undelivered', reason: 'office-mismatch' } }))
  })

  it.each([`app-chat:${TARGET}`, `app-chat:another-app:team:${OFFICE}:${EPOCH}`, buildTeamSessionKey(TARGET, WIDE, EPOCH)])(
    'never resumes an owner or unrelated conversation: %s', conversationId => {
      const h = harness()
      h.deliver(h.wake({ conversationId }))
      expect(h.run).not.toHaveBeenCalled()
      expect(h.send).toHaveBeenCalledWith(PEER, expect.objectContaining({ outcome: { kind: 'undelivered', reason: 'session-key-mismatch' } }))
    })

  it('refuses an epoch known to belong to another office immediately', () => {
    const h = harness()
    const frame = h.wake({ conversationId: buildTeamSessionKey(TARGET, OFFICE, 'wide-epoch') })
    frame.request.teamContext.epochId = 'wide-epoch'
    h.deliver(frame)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.coordinator.pendingWakeAdmissions()).toBe(0)
    expect(h.send).toHaveBeenCalledWith(PEER, expect.objectContaining({ outcome: { kind: 'undelivered', reason: 'epoch-office-mismatch' } }))
  })

  it('refuses a peer claiming a sender owned by another node', () => {
    const h = harness()
    const frame = h.wake()
    frame.request.teamContext.fromAppId = 'other-app'
    h.deliver(frame)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith(PEER, expect.objectContaining({ outcome: { kind: 'undelivered', reason: 'sender-owner-mismatch' } }))
  })

  it('allows a current authority to relay a real member from another node to its owner', async () => {
    const h = harness(OTHER, HOST)
    h.deliver(h.wake(), HOST)
    expect(h.run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.send).toHaveBeenCalledWith(HOST, expect.objectContaining({ correlationId: 'request', outcome: { kind: 'result', content: 'result:work' } }))
  })

  it('waits for missing epoch replication, then executes exactly once with the same bound key', async () => {
    const h = harness(OTHER, HOST)
    h.epochs.delete(EPOCH)
    const frame = h.wake()
    h.deliver(frame, HOST)
    h.deliver(frame, HOST)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.coordinator.pendingWakeAdmissions()).toBe(1)
    h.epochs.set(EPOCH, { id: EPOCH, teamId: OFFICE })
    await vi.advanceTimersByTimeAsync(250)
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.run.mock.calls[0][0].conversationId).toBe(buildTeamSessionKey(TARGET, OFFICE, EPOCH))
    expect(h.coordinator.pendingWakeAdmissions()).toBe(0)
    expect(h.send).toHaveBeenCalledWith(HOST, expect.objectContaining({ outcome: { kind: 'result', content: 'result:work' } }))
  })

  it('reports an unresolvable metadata wait instead of dropping it or running without metadata', async () => {
    const h = harness(OTHER, HOST)
    h.epochs.delete(EPOCH)
    h.deliver(h.wake(), HOST)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.coordinator.pendingWakeAdmissions()).toBe(0)
    expect(h.send).toHaveBeenCalledWith(HOST, expect.objectContaining({ outcome: { kind: 'undelivered', reason: 'wake-metadata-pending' } }))
  })

  it('waits for a changed authority rather than trusting a peer that bypassed the current authority', async () => {
    const h = harness(OTHER, HOST)
    h.deliver(h.wake(), PEER)
    expect(h.run).not.toHaveBeenCalled()
    h.setAuthority(PEER)
    await vi.advanceTimersByTimeAsync(250)
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('does not replay one sender result to another sender reusing its correlation id', async () => {
    const h = harness()
    h.deliver(h.wake({ message: 'first sender' }))
    await vi.advanceTimersByTimeAsync(0)
    const other = h.wake({ message: 'second sender' })
    other.request.teamContext.fromAppId = 'other-app'
    h.deliver(other, OTHER)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(h.send).toHaveBeenCalledWith(OTHER, expect.objectContaining({ outcome: { kind: 'result', content: 'result:second sender' } }))
  })
})
