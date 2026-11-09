import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createParticipantService, type ParticipantSource } from '../../../../src/main/apps/team/participant-service'
import { createWorkMembership } from '../../../../src/main/apps/runtime/team/membership'
import { createMessageBus, type TeamDelivery } from '@hello-halo/agent-sdk/collaboration'
import { buildTeamSessionKey, spaceCoordinatorAppId } from '../../../../src/shared/apps/team-types'
import { validateWakeAdmission } from '../../../../src/main/apps/runtime/federation/wake-admission'

let directory: string
let db: DatabaseManager
let store: TeamStore
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'halo-participant-lifecycle-')))
  db = createDatabaseManager(join(directory, 'state.db'))
  db.runMigrations(db.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(db.getAppDatabase())
  store.insertTeam({ id: 'team', name: 'Team', owningSpaceId: 'space', goal: '', leadAppId: 'lead', memberSourcing: 'manual',
    collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1 })
  store.insertEpoch({ id: 'work', teamId: 'team', startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
  for (const appId of ['lead', 'peer']) store.addMember({ teamId: 'team', appId, memberName: appId, role: appId,
    isLead: appId === 'lead', aiProvisioned: false, addedAt: 1 })
})
afterEach(async () => { db.closeAll(); await rm(directory, { recursive: true, force: true }) })

const caller = { teamId: 'team', epochId: 'work', callerAppId: 'lead' }
const sourceId = buildTeamSessionKey('lead', 'team', 'work')

function fixture(options: { limit?: number; onCreated?: () => Promise<void> } = {}) {
  const busy = new Set<string>()
  const deliveries: Array<{ key: string; deliveries: readonly TeamDelivery[] }> = []
  const bus = createMessageBus({ store: createWorkMembership(store), hooks: {
    isBusy: key => busy.has(key),
    wakeTarget: async request => { busy.add(request.sessionKey); deliveries.push({ key: request.sessionKey, deliveries: request.deliveries! }) },
  } })
  const stop = vi.fn(async ({ appId, teamId, epochId }) => {
    const key = buildTeamSessionKey(appId, teamId, epochId)
    const active = busy.delete(key)
    const last = deliveries.findLast(delivery => delivery.key === key)
    if (last) bus.completeTurn({ sessionKey: key, trigger: last.deliveries[0].trigger, outcome: { kind: 'error', message: 'stopped' }, sealPending: true })
    return active
  })
  const runtime = { bus, stopMemberTurn: stop, discardReports: vi.fn() }
  const service = createParticipantService({ store, getRuntime: () => runtime, maxMembersPerRequest: options.limit ?? 4, onCreated: options.onCreated })
  const source: ParticipantSource = { modelSelection: { modelSourceId: 'fixture', modelId: 'fixture' }, engineId: 'halo',
    environment: { spaceId: 'space', spacePath: directory, workDir: directory, memoryDir: directory }, permissions: { granted: [], denied: [] } }
  service.beginRequest(sourceId, 'request-one')
  return { service, source, bus, stop, busy, deliveries, runtime,
    spawn: (name: string, from = caller) => service.spawn(from, { name, prompt: `Work as ${name}.` }, source) }
}

describe('collaboration request lifecycle', () => {
  it('retains the handle and reports failure when the initial assignment is undelivered', async () => {
    const f = fixture()
    vi.spyOn(f.bus, 'send').mockResolvedValue({ messageId: 'not-delivered', delivery: 'undelivered' })
    await expect(f.spawn('offline')).rejects.toMatchObject({ code: 'participant_retained' })
    const members = store.participants.list('team', 'work')
    expect(members).toHaveLength(1)
    expect(store.participants.getExecution('team', 'work', members[0].appId)?.prompt).toBe('Work as offline.')
    expect(f.deliveries).toHaveLength(0)
  })

  it('keeps an unnamed assignment out of the shared participant profile', async () => {
    const f = fixture()
    const assignment = 'Inspect the confidential source note, keeping its content in this assignment.'
    const member = await f.service.spawn(caller, { prompt: assignment }, f.source)
    expect(member.role).toBe('Collaborator')
    expect(JSON.stringify(store.participants.get(member.teamId, member.epochId, member.appId))).not.toContain(assignment)
    expect(store.participants.getExecution(member.teamId, member.epochId, member.appId)?.prompt).toBe(assignment)
  })

  it('shares creation budgets with nested members, renews only for real source input, and survives service reconstruction', async () => {
    const f = fixture({ limit: 2 })
    const first = await f.spawn('first')
    const childCaller = { ...caller, callerAppId: first.appId }
    await f.spawn('nested', childCaller)
    await expect(f.spawn('extra')).rejects.toThrow(/creation limit/)
    f.service.beginRequest(sourceId, 'request-two')
    await expect(f.spawn('old-nested', childCaller)).rejects.toThrow(/creation limit/)
    await f.spawn('fresh')
    expect(store.participants.list('team', 'work')).toHaveLength(3)
    const restored = createParticipantService({ store: new TeamStore(db.getAppDatabase()), getRuntime: () => f.runtime, maxMembersPerRequest: 2 })
    await restored.spawn(caller, { prompt: 'One remaining creation.' }, f.source)
    await expect(restored.spawn(caller, { prompt: 'Must not reset the budget.' }, f.source)).rejects.toThrow(/creation limit/)
  })

  it('invalidates an allocation awaiting publication before a group has dispatched, and returns its retained handle', async () => {
    let release!: () => void
    const published = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ onCreated: () => published })
    const pending = f.spawn('waiting')
    const refused = expect(pending).rejects.toThrow(/identity is retained/)
    await vi.waitFor(() => expect(store.participants.list('team', 'work')).toHaveLength(1))
    await f.service.stopSource(sourceId)
    f.service.beginRequest(sourceId, 'request-two')
    release(); await refused
    expect(f.deliveries).toHaveLength(0)
    const member = store.participants.list('team', 'work')[0]
    expect(store.participants.getExecution('team', 'work', member.appId)?.stopped).toBe(true)
    const next = f.service.continueTarget(caller, member.appId)
    await f.bus.send({ ...caller, fromAppId: 'lead', to: member.appId, message: 'New instruction.', requestId: next })
    expect(f.deliveries).toHaveLength(1)
    expect(f.deliveries[0].deliveries[0].envelope.body).toBe('New instruction.')
  })

  it('rejects cancelled local work after reconstruction and keeps private participants outside federation', async () => {
    const f = fixture()
    const member = await f.spawn('worker')
    const id = store.participants.getExecution('team', 'work', member.appId)!.requestId!
    const stale = f.service.capture({ ...caller, callerAppId: member.appId, requestId: id })
    const report = f.service.reportGuard('team', 'work', id)
    await f.service.stopSource(sourceId)
    f.service.beginRequest(sourceId, 'request-two')
    const freshId = f.service.continueTarget(caller, member.appId)
    expect(() => stale()).toThrow(/stopped/)
    expect(report()).toBe(false)
    const restored = createParticipantService({ store: new TeamStore(db.getAppDatabase()), getRuntime: () => f.runtime })
    expect(restored.requestAllowed(id)).toBe(false)
    expect(restored.requestAllowed(freshId)).toBe(true)
    const admission = validateWakeAdmission({ officeId: 'team', outerOfficeId: 'team', correlationId: 'late', fromNode: 'owner', selfNodeId: 'owner', authorityNodeId: 'owner', store,
      request: { appId: member.appId, spaceId: 'space', conversationId: buildTeamSessionKey(member.appId, 'team', 'work'), message: 'Late network assignment.',
        teamContext: { teamId: 'team', epochId: 'work', fromAppId: 'lead', correlationId: 'late', wait: false, requestId: id } } })
    expect(admission).toEqual({ ok: false, reason: 'wake-metadata-pending', metadataPending: true })
  })

  it('cancels queued and returned unread work, then resumes only the explicit new assignment', async () => {
    const f = fixture()
    const member = await f.spawn('worker')
    const targetKey = buildTeamSessionKey(member.appId, 'team', 'work')
    const old = f.deliveries[0].deliveries
    await f.bus.send({ teamId: 'team', epochId: 'work', fromAppId: 'lead', to: member.appId, message: 'Old queued work.' })
    await f.service.stop(caller, member.appId)
    const next = f.service.continueTarget(caller, member.appId)
    f.bus.returnDeliveries(targetKey, old)
    await f.bus.send({ teamId: 'team', epochId: 'work', fromAppId: 'lead', to: member.appId, message: 'New work only.', requestId: next })
    expect(f.deliveries).toHaveLength(2)
    expect(f.deliveries[1].deliveries.map(delivery => delivery.envelope.body)).toEqual(['New work only.'])
  })

  it('does not close the lead running team_stop all, or renew the budget through a member resume', async () => {
    const f = fixture({ limit: 1 })
    const member = await f.spawn('worker')
    const leadCheck = f.service.capture(caller)
    await f.service.stop(caller, 'all')
    expect(f.stop.mock.calls.some(([input]) => input.appId === 'lead')).toBe(false)
    expect(() => leadCheck()).not.toThrow()
    const id = f.service.continueTarget(caller, member.appId)
    await expect(f.service.spawn({ ...caller, callerAppId: member.appId, requestId: id }, { prompt: 'No extra quota.' }, f.source)).rejects.toThrow(/creation limit/)
  })

  it('refuses remote conditional stops before cancelling any local or remote assignment', async () => {
    const f = fixture()
    const local = await f.spawn('local')
    store.addMember({ teamId: 'team', appId: 'remote', memberName: 'remote', role: '', isLead: false,
      aiProvisioned: false, addedAt: 1, origin: 'remote', ownerNodeId: 'other-machine' })
    const remoteKey = buildTeamSessionKey('remote', 'team', 'work')
    store.requests.track(remoteKey, 'remote-assignment', { appId: 'lead' })
    const remoteFence = f.service.recipientFence({ teamId: 'team', epochId: 'work', appId: 'remote' })
    const localCheck = f.service.capture({ ...caller, callerAppId: local.appId })
    await expect(f.service.stop(caller, 'remote')).rejects.toMatchObject({ code: 'remote_stop_unsupported' })
    await expect(f.service.stop(caller, 'all')).rejects.toMatchObject({ code: 'remote_stop_unsupported' })
    expect(f.service.requestAllowed('remote-assignment')).toBe(true)
    expect(f.service.recipientFence({ teamId: 'team', epochId: 'work', appId: 'remote' })).toBe(remoteFence)
    expect(() => localCheck()).not.toThrow()
    expect(store.participants.getExecution('team', 'work', local.appId)?.stopped).not.toBe(true)
    expect(f.stop).not.toHaveBeenCalled()
    expect(await f.service.stop(caller, local.appId)).toEqual([{ member: local.appId, stopped: true, pending: false }])
  })

  it('a guest driving a lead cannot control owner work or remote members through its title', async () => {
    const f = fixture()
    const ownerWork = await f.spawn('owner')
    const guest = { ...caller, origin: 'guest' as const, requestId: 'guest-request' }
    await expect(f.service.stop(guest, ownerWork.appId)).rejects.toThrow(/may stop/)
    const helper = await f.service.spawn(guest, { prompt: 'Guest work.' }, f.source)
    await expect(f.service.stop(guest, helper.appId)).resolves.toHaveLength(1)
    expect(store.participants.getExecution('team', 'work', ownerWork.appId)?.stopped).not.toBe(true)
  })

  it('fences the first source allocation even when no collaboration group existed at stop time', async () => {
    const f = fixture()
    f.service.beginRequest('new-space-chat', 'first-request')
    const current = f.service.captureSource('new-space-chat')
    await f.service.stopSource('new-space-chat')
    f.service.beginRequest('new-space-chat', 'second-request')
    expect(() => current()).toThrow(/stopped/)
    expect(() => f.service.captureSource('new-space-chat')()).not.toThrow()
  })

  it('cancels executed and queued source requests together before accepting a later human request', async () => {
    const f = fixture()
    await f.spawn('first')
    f.service.beginRequest(sourceId, 'queued-request')
    await f.service.stopSource(sourceId)
    f.service.beginRequest(sourceId, 'resumed-request')
    f.service.sourceRequestId(sourceId)
    expect(f.service.requestAllowed('request-one/late-network-branch')).toBe(false)
    expect(f.service.requestAllowed('queued-request')).toBe(false)
    expect(f.service.requestAllowed('resumed-request')).toBe(true)
  })

  it('permits ordinary peer replies while preventing a peer from unlocking a stopped recipient', async () => {
    const f = fixture()
    const member = await f.spawn('worker')
    const child = { ...caller, callerAppId: member.appId }
    expect(f.service.continueTarget(child, 'lead')).toMatch(/^request-one\//)
    expect(f.service.continueTarget(child, 'peer')).toMatch(/^request-one\//)
    f.service.markStopped({ ...caller, callerAppId: 'peer' })
    await expect(Promise.resolve().then(() => f.service.continueTarget(child, 'peer'))).rejects.toThrow(/controller/)
  })

  it('a member stop cancels its branch without cancelling a sibling sharing the same request budget', async () => {
    const f = fixture()
    const first = await f.spawn('first')
    const second = await f.spawn('second')
    const firstId = store.participants.getExecution('team', 'work', first.appId)!.requestId!
    const secondId = store.participants.getExecution('team', 'work', second.appId)!.requestId!
    f.service.adoptRequest({ ...caller, callerAppId: first.appId }, firstId)
    await f.service.stopSource(buildTeamSessionKey(first.appId, 'team', 'work'))
    expect(f.service.requestAllowed(firstId)).toBe(false)
    expect(f.service.requestAllowed(secondId)).toBe(true)
    expect(f.service.requestAllowed('request-one')).toBe(true)
  })

  it('a newer owner input revokes a prepared controller stop before interruption or unread-input withdrawal', async () => {
    const f = fixture()
    const member = await f.spawn('worker')
    const targetKey = buildTeamSessionKey(member.appId, 'team', 'work')
    const assignment = store.requests.current(targetKey)!
    await f.bus.send({ teamId: 'team', epochId: 'work', fromAppId: 'lead', to: member.appId, message: 'Old unread instruction.', requestId: assignment })
    const prepared = f.service.prepareControlledStop({ teamId: 'team', epochId: 'work', appId: member.appId }, { appId: 'lead', requestId: assignment })
    expect(prepared.isCurrent(member.appId)).toBe(true)
    f.service.beginRequest(targetKey, 'new-owner-input')
    await f.bus.send({ teamId: 'team', epochId: 'work', fromAppId: null, to: member.appId, message: 'New human instruction.', requestId: 'new-owner-input' })
    expect(prepared.isCurrent(member.appId)).toBe(false)
    const old = f.deliveries[0].deliveries[0]
    f.busy.delete(targetKey)
    f.bus.completeTurn({ sessionKey: targetKey, trigger: old.trigger, outcome: { kind: 'error', message: 'Old assignment ended.' } })
    await vi.waitFor(() => expect(f.deliveries).toHaveLength(2))
    expect(f.deliveries[1].deliveries.map(item => item.envelope.body)).toEqual(['New human instruction.'])
    await expect(f.service.stop(caller, member.appId)).rejects.toThrow(/currently control/)
    expect(f.service.requestAllowed('new-owner-input')).toBe(true)
  })

  it('sending another model assignment does not seize control from the current human turn', async () => {
    const f = fixture()
    const member = await f.spawn('worker')
    const targetKey = buildTeamSessionKey(member.appId, 'team', 'work')
    f.service.beginRequest(targetKey, 'owner-work')
    f.service.continueTarget(caller, member.appId)
    expect(store.requests.assignment(targetKey)).toEqual({ requestId: 'owner-work' })
    await expect(f.service.stop(caller, member.appId)).rejects.toThrow(/currently control/)
  })

  it('persists controller identity and refuses a forged or differently privileged stop', async () => {
    const f = fixture()
    const member = await f.spawn('worker')
    const target = { teamId: 'team', epochId: 'work', appId: member.appId }
    const id = store.requests.current(buildTeamSessionKey(member.appId, 'team', 'work'))!
    const restored = createParticipantService({ store: new TeamStore(db.getAppDatabase()), getRuntime: () => f.runtime })
    expect(() => restored.prepareControlledStop(target, { appId: 'peer', requestId: id })).toThrow(/no longer controlled/)
    expect(() => restored.prepareControlledStop(target, { appId: 'lead', requestId: id, origin: 'guest' })).toThrow(/no longer controlled/)
    expect(restored.prepareControlledStop(target, { appId: 'lead', requestId: id }).appIds).toEqual([member.appId])
  })

  it('does not persist unused source endpoints or ordinary user messages', async () => {
    const f = fixture()
    f.service.registerSource('ordinary')
    f.service.beginRequest('ordinary', 'ordinary-input')
    expect(f.service.hasSource('ordinary')).toBe(true)
    expect(store.requests.current('ordinary')).toBeNull()
    await f.service.stopSource('ordinary')
    expect(store.requests.current('ordinary')).toBeNull()
    expect(f.service.sourceState('ordinary').stopped).toBe(true)
  })

  it('accepts a coordinator reply without letting the child claim the source controller', async () => {
    const f = fixture()
    const coordinator = spaceCoordinatorAppId('conversation')
    store.insertTeam({ id: 'source-team', name: '', owningSpaceId: 'space', goal: '', leadAppId: coordinator,
      coordinatorConversationId: 'conversation', ephemeral: true, memberSourcing: 'manual', collabMode: 'free',
      escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1 })
    store.insertEpoch({ id: 'source-work', teamId: 'source-team', startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
    store.addMember({ teamId: 'source-team', appId: coordinator, memberName: 'lead', role: '', isLead: true, aiProvisioned: false, addedAt: 1 })
    const lead = { teamId: 'source-team', epochId: 'source-work', callerAppId: coordinator }
    f.service.beginRequest('conversation', 'source-request')
    const member = await f.service.spawn(lead, { prompt: 'Research.' }, f.source)
    const child = { ...lead, callerAppId: member.appId }
    const reply = f.service.continueTarget(child, coordinator)
    expect(f.service.adoptRequest(lead, reply, { appId: member.appId })).toBe('source-request')
    expect(store.requests.assignment('conversation')).toEqual({ requestId: 'source-request' })
    expect(store.requests.assignment(buildTeamSessionKey(coordinator, 'source-team', 'source-work'))).toBeNull()
    await expect(f.service.stop(child, coordinator)).rejects.toThrow(/currently control/)
    await f.service.stopSource('conversation')
    f.service.beginRequest('conversation', 'source-request-two')
    await expect(f.service.spawn(lead, { prompt: 'Fresh research.' }, f.source)).resolves.toMatchObject({ isTemporary: true })
  })

  it('refuses an App identity collision before creating workspace directories', async () => {
    const f = fixture()
    const guarded = createParticipantService({ store, getRuntime: () => f.runtime, identityExists: () => true })
    await expect(guarded.spawn(caller, { prompt: 'Research.' }, f.source)).rejects.toThrow(/already in use/)
    expect(store.participants.list('team', 'work')).toEqual([])
    expect(await readdir(directory)).not.toContain('collaboration')
  })


  it('refuses an unsupported remote stop after assigning work without changing its controller', async () => {
    const f = fixture()
    store.addMember({ teamId: 'team', appId: 'remote', memberName: 'remote', role: '', isLead: false,
      aiProvisioned: false, addedAt: 1, ownerNodeId: 'other-node', origin: 'remote' })
    const assignment = f.service.continueTarget(caller, 'remote')
    await expect(f.service.stop(caller, 'remote')).rejects.toMatchObject({ code: 'remote_stop_unsupported' })
    expect(store.requests.assignment(buildTeamSessionKey('remote', 'team', 'work'))).toEqual({
      requestId: assignment, controller: { appId: 'lead' },
    })
    expect(f.service.requestAllowed(assignment)).toBe(true)
    expect(f.stop).not.toHaveBeenCalled()
  })


  it('does not swallow a second human stop while the first owner response is delayed', async () => {
    const f = fixture()
    await f.spawn('worker')
    const releases: Array<() => void> = []
    f.runtime.stopMemberTurn = vi.fn((_input: unknown) => new Promise<boolean>(resolve => { releases.push(() => resolve(true)) }))
    const first = f.service.stopSource(sourceId)
    f.service.beginRequest(sourceId, 'request-two')
    const second = f.service.stopSource(sourceId)
    expect(f.service.requestAllowed('request-two')).toBe(false)
    for (const release of releases) release()
    await Promise.all([first, second])
    expect(f.service.requestAllowed('request-one')).toBe(false)
  })


  it('stopping one assignment preserves its sibling report guard', async () => {
    const f = fixture()
    const left = await f.spawn('left')
    const right = await f.spawn('right')
    const leftToken = store.participants.getExecution('team', 'work', left.appId)!.requestId!
    const rightToken = store.participants.getExecution('team', 'work', right.appId)!.requestId!
    const leftReport = f.service.reportGuard('team', 'work', leftToken)
    const rightReport = f.service.reportGuard('team', 'work', rightToken)
    await f.service.stop(caller, left.appId)
    expect(leftReport()).toBe(false)
    expect(rightReport()).toBe(true)
    expect(f.runtime.discardReports).not.toHaveBeenCalled()
  })


  it('keeps a sibling reply on the receiver assignment and does not transfer its controller', async () => {
    const f = fixture()
    const left = await f.spawn('left')
    const right = await f.spawn('right')
    const leftCaller = { ...caller, callerAppId: left.appId }
    const rightCaller = { ...caller, callerAppId: right.appId }
    const rightKey = buildTeamSessionKey(right.appId, 'team', 'work')
    const previous = store.requests.assignment(rightKey)!
    const localReply = f.service.continueTarget(leftCaller, right.appId)
    expect(localReply.startsWith(`${store.participants.getExecution('team', 'work', left.appId)!.requestId}/`)).toBe(true)
    expect(f.service.adoptRequest(rightCaller, localReply, { appId: left.appId })).toBe(previous.requestId)
    const remoteReply = `${store.participants.getExecution('team', 'work', left.appId)!.requestId}/remote-reply`
    expect(f.service.adoptRequest(rightCaller, remoteReply, { appId: left.appId })).toBe(previous.requestId)
    expect(store.requests.assignment(rightKey)).toEqual(previous)
    await expect(f.service.stop(caller, right.appId)).resolves.toHaveLength(1)
  })


  it('guards a delayed source stop against a new owner assignment and leaves unrelated human work alone', async () => {
    const f = fixture()
    const member = await f.spawn('worker')
    const target = { teamId: 'team', epochId: 'work', appId: member.appId }
    const targetKey = buildTeamSessionKey(member.appId, 'team', 'work')
    const old = store.requests.current(targetKey)!
    const prepared = f.service.prepareSourceStop(target, old)
    f.service.beginRequest(targetKey, 'owner-independent')
    expect(prepared.isCurrent(member.appId)).toBe(false)
    expect(() => f.service.prepareSourceStop(target, old)).toThrow(/no longer controlled/)
    f.stop.mockClear()
    await f.service.stopSource(sourceId)
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.service.requestAllowed('owner-independent')).toBe(true)
    expect(store.participants.getExecution('team', 'work', member.appId)?.stopped).toBe(false)
  })


  it('an owner admits a fresh remote controller assignment after stop without reviving old deliveries', async () => {
    const f = fixture()
    const member = await f.spawn('worker')
    const targetCaller = { ...caller, callerAppId: member.appId }
    const previous = store.participants.getExecution('team', 'work', member.appId)!.requestId!
    f.service.markStopped(targetCaller)
    const fence = f.service.recipientFence({ teamId: 'team', epochId: 'work', appId: member.appId })
    expect(f.service.adoptRequest(targetCaller, previous, { appId: 'lead' })).toBe(false)
    expect(f.service.adoptRequest(targetCaller, 'fresh-remote/branch', { appId: 'peer' })).toBe(false)
    expect(f.service.adoptRequest(targetCaller, 'fresh-remote/branch', { appId: 'lead' })).toBe('fresh-remote/branch')
    expect(store.participants.getExecution('team', 'work', member.appId)?.stopped).toBe(false)
    expect(f.service.recipientFence({ teamId: 'team', epochId: 'work', appId: member.appId })).toBe(fence)
  })

})
