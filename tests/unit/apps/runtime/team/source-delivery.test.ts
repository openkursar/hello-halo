import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import { Emitter } from '../../../../../src/main/platform/event'
import { migrations, MIGRATION_NAMESPACE } from '../../../../../src/main/apps/team/migrations'
import { createCollaborationRequests } from '../../../../../src/main/apps/team/collaboration-requests'
import { createCollaborationSourceBindings } from '../../../../../src/main/apps/team/source-bindings'
import { buildImSessionKey } from '../../../../../src/shared/apps/im-keys'
import { resolveImPermission } from '../../../../../src/main/apps/runtime/im-sender-standing'
import type { AppChatRequest } from '../../../../../src/main/apps/runtime/app-chat'
import type { CoordinatorDeliveryRequest } from '../../../../../src/main/apps/runtime/team/space-coordinator'

const mailbox = vi.hoisted(() => ({
  busy: false, identity: 'owner', inject: vi.fn((_conversationId: string, ..._args: unknown[]) => true),
  changes: new Set<(key: string) => void>(),
  observations: [] as Array<{ reply: (text: string) => void; finish: () => void }>,
}))
vi.mock('../../../../../src/main/services/agent', () => ({
  formatCanvasContext: () => '', emitAgentEvent: vi.fn(), onAgentEvent: () => ({ dispose: () => {} }), isEngineSetupError: () => false,
}))
vi.mock('../../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: () => mailbox.busy,
  getAppChatTurnIdentity: () => mailbox.identity,
  appChatMessageIdentity: (permission: any, origin?: string) => permission?.isOwner === false ? `guest:${JSON.stringify(permission.guestPolicy ?? {})}` : origin ?? 'owner',
  injectIntoAppChatBatch: mailbox.inject, keepStoppedInputs: () => {}, refreshAppChatTurnStarts: () => {},
  onAppChatConversationChange: (callback: (key: string) => void) => { mailbox.changes.add(callback); return () => mailbox.changes.delete(callback) },
}))
vi.mock('../../../../../src/main/apps/runtime/app-chat-sink', () => ({
  peekAppChatSink: () => ({ canObserveLiveTurn: () => true, observeLiveTurn: (callbacks: { onReply?: (text: string) => void }) => {
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    mailbox.observations.push({ reply: text => callbacks.onReply?.(text), finish })
    return { done, cancel: finish }
  } }),
}))
vi.mock('../../../../../src/main/apps/runtime/im-permission-registry', () => ({ getImPermissionContext: () => ({ senderId: 'newest-owner', senderName: 'Newest owner', isOwner: true }) }))

vi.mock('../../../../../src/main/apps/manager', () => ({ getAppManager: () => null }))
const teamHost = vi.hoisted(() => ({ store: null as any, participants: null as any }))
vi.mock('../../../../../src/main/apps/team', () => ({ getTeamService: () => teamHost.participants ? { participants: teamHost.participants } : null, getTeamStore: () => teamHost.store }))
vi.mock('../../../../../src/main/apps/runtime/im-channels', () => ({ getActiveImChannelManager: () => null }))
vi.mock('../../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => null }))
vi.mock('../../../../../src/main/apps/runtime/im-channels/file-send-resolve', () => ({ resolveImFileSend: () => undefined }))
vi.mock('../../../../../src/main/services/space.service', () => ({ getSpaceDir: () => '/space' }))
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { buildTeamSessionKey } from '../../../../../src/shared/apps/im-keys'
import { bindTeamCollaborationSource, deliverTeamCollaborationSource, createOwnedCollaborationSourceDelivery } from '../../../../../src/main/apps/runtime/team/source-delivery'
import { createAppChatDelivery } from '../../../../../src/main/apps/runtime/app-chat-delivery'

const cleanups: Array<() => void> = []
beforeEach(() => { mailbox.busy = false; mailbox.identity = 'owner'; mailbox.inject.mockClear(); mailbox.changes.clear(); mailbox.observations = [] })
afterEach(() => { teamHost.store = null; teamHost.participants = null; cleanups.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks() })

function fixture(sender = 'owner') {
  const manager = createDatabaseManager(':memory:')
  const db = manager.getAppDatabase()
  manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  cleanups.push(() => manager.closeAll())
  const requests = createCollaborationRequests(db)
  const sourceBindings = createCollaborationSourceBindings(db)
  const app: any = { id: 'person', status: 'active', spaceId: 'space', permissions: { granted: ['read'], denied: [] }, userOverrides: {} }
  const config: any = { id: 'instance', type: 'wecom-bot', enabled: true, appId: app.id, permissionEnabled: true, owners: ['owner'], guestPolicy: { allowCollaboration: true, allowedTools: [] }, replyScope: 'all', config: { credential: 'private-credential' } }
  const session: any = { appId: app.id, channel: config.type, source: 'im', instanceId: config.id, chatId: 'original-room', chatType: 'group', displayName: 'Original room', lastSender: sender, proactive: false, lastActiveAt: 1 }
  const conversationId = buildImSessionKey(app.id, session.channel, session.chatType, session.chatId)
  const changed = new Emitter<string>()
  const state = { contextId: 'context-one', session: session as any, instancePresent: true, authorizationChanged: changed }
  const appChanged = new Set<(id: string) => void>()
  const uninstalled = new Set<(app: any, reason: any) => void>()
  const push = vi.fn(() => true)
  const fileSend = vi.fn(async () => true)
  const host = createOwnedCollaborationSourceDelivery({
    store: () => ({ requests, sourceBindings, getTeamById: () => ({ coordinatorConversationId: conversationId }) as any }),
    participants: () => ({ registerSource: vi.fn(), requestAllowed: id => !requests.cancelled(id) }),
    apps: () => ({ getApp: id => id === app.id ? app : null, onAppAuthorityChanged: callback => { appChanged.add(callback); return () => appChanged.delete(callback) }, onAppUninstalled: callback => { uninstalled.add(callback); return () => uninstalled.delete(callback) } }),
    channels: () => ({ getInstanceConfig: id => id === config.id ? config : undefined, getInstance: id => id === config.id && state.instancePresent ? { pushToChat: push } as any : undefined, onAuthorizationChanged: state.authorizationChanged.event }),
    sessions: () => ({ findSession: (id, channel, chat) => id === app.id && channel === config.type && chat === session.chatId && state.session ? { ...state.session, contextId: state.contextId } : undefined, getSessionContextId: () => state.session ? state.contextId : undefined }),
    fileSend: () => fileSend,
    spaceDir: () => '/space',
  })
  const retire = host.observe()
  cleanups.push(retire)
  const bind = (requestId = 'original', who = sender) => {
    requests.begin(conversationId, requestId)
    host.bind({ appId: app.id, conversationId, requestId,
      permission: resolveImPermission(config, who, `${who} name`),
      imSession: { channel: config.type, chatType: session.chatType, displayName: session.displayName, sessionId: `${config.id}:${session.chatId}` } })
  }
  const request = (requestId = 'original/child'): CoordinatorDeliveryRequest => ({
    spaceId: 'space', conversationId, permissionIdentity: sender === 'owner' ? 'owner' : 'external',
    turnInput: 'UNREVIEWED_MEMBER_OUTPUT', persist: { content: 'UNREVIEWED_MEMBER_OUTPUT', metadata: { requestId, teamId: 'team', epochId: 'epoch', teamName: 'Work', fromMemberName: 'Investigator', teamTriggerKind: 'message' } },
  })
  return { manager, requests, sourceBindings, host, app, config, state, session, changed, appChanged, uninstalled, push, fileSend, bind, request, conversationId, retire }
}

function receiver(disposition: 'dispatched' | 'mid_turn' | 'buffered' = 'dispatched') {
  let captured!: AppChatRequest
  const send = vi.fn((input: AppChatRequest) => {
    captured = input
    input.onAdmitted?.(disposition)
    return new Promise<void>(() => {})
  })
  return { send, get input() { return captured } }
}

describe('member-private assistant results', () => {
  function privateFixture(origin?: 'guest' | 'colleague') {
    const h = fixture()
    const store = new TeamStore(h.manager.getAppDatabase())
    teamHost.store = store
    teamHost.participants = { requestAllowed: (id: string) => !store.requests.cancelled(id),
      recipientFence: store.recipientFences.read, acceptRecipientFence: store.recipientFences.accepts }
    const conversationId = buildTeamSessionKey('member', 'public', 'work')
    for (const id of ['public', 'private']) store.insertTeam({ id, name: id, owningSpaceId: 'space', goal: '', leadAppId: 'member',
      memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1,
      ...(id === 'private' ? { ephemeral: true, coordinatorConversationId: conversationId } : {}) })
    store.addMember({ teamId: 'public', appId: 'member', memberName: 'member', role: '', isLead: false, aiProvisioned: false, addedAt: 1 })
    store.insertEpoch({ id: 'work', teamId: 'public', startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
    store.requests.begin(conversationId, 'root/member')
    bindTeamCollaborationSource({ conversationId, parentRequestId: 'root/member', requestId: 'root/member/private', origin })
    const request: CoordinatorDeliveryRequest = { ...h.request('root/member/private/child'), conversationId,
      parentTeam: { appId: 'member', teamId: 'public', epochId: 'work', correlationId: 'child-report' },
      persist: { ...h.request().persist, metadata: { ...h.request().persist.metadata, teamId: 'private', requestId: 'root/member/private/child' } } }
    return { store, request, conversationId }
  }
  it.each([undefined, 'guest', 'colleague'] as const)('joins the exact live parent under its original %s authority', async origin => {
    const h = privateFixture(origin)
    mailbox.busy = true; mailbox.identity = origin ?? 'owner'
    const run = vi.fn(async (_input: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    cleanups.push(() => delivery.dispose())
    expect(await deliverTeamCollaborationSource(h.request, input => delivery.send(input))).toEqual({ handled: true, disposition: 'mid_turn' })
    expect(mailbox.inject.mock.calls[0][0]).toBe(h.conversationId)
    expect(run).not.toHaveBeenCalled()
    mailbox.observations[0].finish()
  })
  it('defers restricted results behind owner work, then resumes the same parent without human authorization', async () => {
    const h = privateFixture('guest')
    mailbox.busy = true
    const run = vi.fn(async (_input: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    cleanups.push(() => delivery.dispose())
    expect(await deliverTeamCollaborationSource(h.request, input => delivery.send(input))).toEqual({ handled: true, disposition: 'buffered' })
    expect(mailbox.inject).not.toHaveBeenCalled()
    mailbox.busy = false
    for (const changed of mailbox.changes) changed(h.conversationId)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run.mock.calls[0][0]).toMatchObject({ conversationId: h.conversationId, internalAssistantResult: true,
      teamContext: { origin: 'guest', requestId: 'root/member', kind: 'message', correlationId: 'child-report' },
      recorded: { provenance: { source: 'team-message' } } })
    expect(run.mock.calls[0][0].humanInput).toBeUndefined()
  })
  it('drops a revoked private branch without touching a sibling parent request', async () => {
    const h = privateFixture()
    const result = receiver()
    await deliverTeamCollaborationSource(h.request, result.send)
    h.store.requests.cancel('root/member/private')
    expect(result.input.canStart?.()).toBe(false)
    expect(h.store.requests.cancelled('root/other-member')).toBe(false)
    expect(result.input.refreshBeforeDelivery?.()).toBeUndefined()
  })
})

describe('owned IM collaboration results', () => {
  it.each(['owner', 'guest'])('joins an active source turn with the same %s authority through the actual mailbox', async sender => {
    const h = fixture(sender); h.bind()
    mailbox.busy = true
    mailbox.identity = sender === 'owner' ? 'owner' : `guest:${JSON.stringify(h.config.guestPolicy)}`
    const run = vi.fn(async (_input: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    cleanups.push(() => delivery.dispose())
    expect(await h.host.deliver(h.request(), input => delivery.send(input))).toEqual({ handled: true, disposition: 'mid_turn' })
    expect(mailbox.inject).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
    expect(h.push).not.toHaveBeenCalled()
    mailbox.observations[0].reply('REVIEWED_DURING_ACTIVE_TURN')
    mailbox.observations[0].finish()
    expect(h.push).toHaveBeenCalledWith('original-room', 'REVIEWED_DURING_ACTIVE_TURN', 'group')
  })

  it('queues the captured guest behind an owner and resumes with the original guest permissions', async () => {
    const h = fixture('guest'); h.bind()
    mailbox.busy = true
    const run = vi.fn(async (input: AppChatRequest) => { input.onReply?.('GUEST_SOURCE_REVIEWED') })
    const delivery = createAppChatDelivery(run)
    cleanups.push(() => delivery.dispose())
    expect(await h.host.deliver(h.request(), input => delivery.send(input))).toEqual({ handled: true, disposition: 'buffered' })
    expect(mailbox.inject).not.toHaveBeenCalled()
    mailbox.busy = false
    for (const changed of mailbox.changes) changed(h.conversationId)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run.mock.calls[0][0].imPermission).toMatchObject({ senderId: 'guest', isOwner: false })
    expect(h.push).toHaveBeenCalledWith('original-room', 'GUEST_SOURCE_REVIEWED', 'group')
  })

  it('drops a cancelled queued result before the real mailbox wakes an idle source', async () => {
    const h = fixture('guest'); h.bind()
    mailbox.busy = true
    const run = vi.fn(async (_input: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    cleanups.push(() => delivery.dispose())
    await h.host.deliver(h.request(), input => delivery.send(input))
    h.requests.cancel('original')
    const cancelled = vi.spyOn(h.requests, 'cancelled')
    mailbox.busy = false
    for (const changed of mailbox.changes) changed(h.conversationId)
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith('original/child'))
    expect(run).not.toHaveBeenCalled()
    expect(h.push).not.toHaveBeenCalled()
  })
  it.each(['owner', 'guest'])('retains the original %s caller and returns admission before the source AI finishes', async sender => {
    const h = fixture(sender); h.bind()
    h.session.lastSender = sender === 'owner' ? 'later guest' : 'later owner'
    const result = receiver('mid_turn')
    expect(await h.host.deliver(h.request(), result.send)).toEqual({ handled: true, disposition: 'mid_turn' })
    expect(result.input.imPermission).toMatchObject({ senderId: sender, isOwner: sender === 'owner' })
    expect(result.input.collaborationRequestId).toBe('original/child')
    expect(result.input.message).toContain('not new user authorization')
    expect(h.push).not.toHaveBeenCalled()
    result.input.onReply?.('SOURCE_AI_REVIEWED_RESULT')
    expect(h.push).toHaveBeenCalledTimes(1)
    expect(h.push).toHaveBeenCalledWith('original-room', 'SOURCE_AI_REVIEWED_RESULT', 'group')
    expect(h.requests.current(h.conversationId)).toBe('original')
    const stored = JSON.stringify(h.sourceBindings.get('original'))
    expect(stored).not.toContain('UNREVIEWED_MEMBER_OUTPUT')
    expect(stored).not.toContain('private-credential')
  })

  it('refuses ungranted guests before writing any binding', () => {
    const h = fixture('guest'); h.config.guestPolicy = { allowedTools: [] }
    expect(() => h.bind()).toThrow('collaboration not granted')
    expect(h.sourceBindings.get('original')).toBeNull()
  })

  it('fails closed when authority observation has not been initialized', async () => {
    const h = fixture(); h.retire()
    expect(() => h.bind()).toThrow('not initialized')
    await expect(h.host.deliver(h.request(), receiver().send)).rejects.toThrow('not initialized')
  })

  it('retires old callbacks without revoking a valid persisted source for the next runtime', async () => {
    const h = fixture('guest'); h.bind()
    const prior = receiver(); await h.host.deliver(h.request(), prior.send)
    h.retire()
    prior.input.onReply?.('RETIRED_RUNTIME_REPLY')
    expect(h.push).not.toHaveBeenCalled()
    expect(h.sourceBindings.get('original')?.revoked).toBe(false)
    cleanups.push(h.host.observe())
    h.session.lastSender = 'newest owner after restart'
    const resumed = receiver(); await h.host.deliver(h.request(), resumed.send)
    expect(resumed.input.imPermission?.senderId).toBe('guest')
    resumed.input.onReply?.('RESTORED_SOURCE_REVIEW')
    expect(h.push).toHaveBeenCalledWith('original-room', 'RESTORED_SOURCE_REVIEW', 'group')
  })

  it('ignores retired authority observers when a new runtime is already observing', () => {
    const h = fixture(); h.bind()
    const next = new Emitter<string>()
    h.state.authorizationChanged = next
    cleanups.push(h.host.observe())
    h.bind('new-runtime-request')
    h.changed.fire('instance')
    h.retire()
    expect(h.requests.cancelled('new-runtime-request')).toBe(false)
    next.fire('instance')
    expect(h.requests.cancelled('new-runtime-request')).toBe(true)
  })

  it('cancels one branch without revoking its source or sibling reports', async () => {
    const h = fixture(); h.bind()
    const left = receiver(), right = receiver()
    await h.host.deliver(h.request('original/left'), left.send)
    await h.host.deliver(h.request('original/right'), right.send)
    h.requests.cancel('original/left')
    expect(left.input.onReply?.('STOPPED_BRANCH')).toBe(false)
    expect(h.requests.cancelled('original')).toBe(false)
    expect(h.requests.cancelled('original/right')).toBe(false)
    expect(h.sourceBindings.get('original')?.revoked).toBe(false)
    right.input.onReply?.('SIBLING_REVIEWED')
    expect(h.push).toHaveBeenCalledOnce()
    expect(h.push).toHaveBeenCalledWith('original-room', 'SIBLING_REVIEWED', 'group')
  })

  it('delivers a merged reviewed reply through the surviving branch exactly once', async () => {
    const h = fixture('guest'); h.bind()
    mailbox.busy = true
    let merged: AppChatRequest | undefined
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const run = vi.fn(async (input: AppChatRequest) => { merged = input; await done })
    const delivery = createAppChatDelivery(run)
    cleanups.push(() => delivery.dispose())
    await h.host.deliver(h.request('original/left'), input => delivery.send(input))
    await h.host.deliver(h.request('original/right'), input => delivery.send(input))
    mailbox.busy = false
    for (const changed of mailbox.changes) changed(h.conversationId)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    h.requests.cancel('original/left')
    expect(merged?.onReply?.('ONE_REVIEWED_REPLY')).toBe(true)
    finish()
    await done
    expect(h.requests.cancelled('original/right')).toBe(false)
    expect(h.push).toHaveBeenCalledOnce()
    expect(h.push).toHaveBeenCalledWith('original-room', 'ONE_REVIEWED_REPLY', 'group')
  })

  it.each(['channel', 'app'])('permanently revokes old requests on %s authority changes without cancelling a later input', async kind => {
    const h = fixture(); h.bind()
    const old = receiver('buffered'); await h.host.deliver(h.request(), old.send)
    if (kind === 'channel') {
      h.config.owners = ['someone-else']; h.changed.fire('instance'); h.config.owners = ['owner']; h.changed.fire('instance')
    } else {
      h.app.permissions.denied = ['read']; for (const listener of h.appChanged) listener('person')
      h.app.permissions.denied = []; for (const listener of h.appChanged) listener('person')
    }
    h.bind('later-human')
    expect(h.requests.cancelled('original/child')).toBe(true)
    expect(h.requests.cancelled('later-human')).toBe(false)
    expect(old.input.refreshBeforeDelivery?.()).toBeUndefined()
    old.input.onReply?.('STALE_REVIEWED_RESULT')
    expect(h.push).not.toHaveBeenCalled()
    expect(() => h.bind('original')).toThrow('stopped')
    const next = receiver(); await h.host.deliver(h.request('later-human/child'), next.send)
    next.input.onReply?.('CURRENT_REVIEWED_RESULT')
    expect(h.push).toHaveBeenCalledTimes(1)
    expect(h.push).toHaveBeenCalledWith('original-room', 'CURRENT_REVIEWED_RESULT', 'group')
  })

  it.each(['stop', 'clear', 'recipient', 'policy', 'uninstall'])('revalidates %s at queued admission, file delivery and final reply', async reason => {
    const h = fixture(); h.bind()
    const pending = receiver('buffered'); await h.host.deliver(h.request(), pending.send)
    if (reason === 'stop') h.requests.cancel('original')
    if (reason === 'clear') h.state.contextId = 'context-after-clear'
    if (reason === 'recipient') h.state.session = { ...h.session, chatId: 'another-room' }
    if (reason === 'policy') h.config.guestPolicy = { allowCollaboration: false }
    if (reason === 'uninstall') { h.app.status = 'uninstalled'; for (const listener of h.uninstalled) listener(h.app, 'user') }
    expect(pending.input.canStart?.()).toBe(false)
    expect(pending.input.refreshBeforeDelivery?.()).toBeUndefined()
    expect(await pending.input.imFileSend?.('/space/output.txt')).toBe(false)
    pending.input.onReply?.('STALE_RESULT')
    expect(h.push).not.toHaveBeenCalled()
    expect(h.fileSend).not.toHaveBeenCalled()
  })

  it('does not fall through to generic chat delivery for missing or foreign IM bindings', async () => {
    const h = fixture(); const received = receiver()
    expect(await h.host.deliver(h.request(), received.send)).toMatchObject({ handled: true })
    h.bind()
    const other = { ...h.request(), conversationId: buildImSessionKey('person', 'wecom-bot', 'group', 'other-room') }
    expect(await h.host.deliver(other, received.send)).toMatchObject({ handled: true })
    expect(received.send).not.toHaveBeenCalled()
    expect(await h.host.deliver({ ...h.request(), conversationId: 'space-conversation' }, received.send)).toEqual({ handled: false })
  })

  it('reports unavailable delivery instead of acknowledging a lost result', async () => {
    const h = fixture(); h.bind(); h.state.instancePresent = false
    await expect(h.host.deliver(h.request(), receiver().send)).rejects.toThrow('temporarily unavailable')
  })

  it('propagates admission rejection without sending an unreviewed result', async () => {
    const h = fixture(); h.bind()
    await expect(h.host.deliver(h.request(), vi.fn(async () => { throw new Error('mailbox full') }))).rejects.toThrow('mailbox full')
    expect(h.push).not.toHaveBeenCalled()
  })
})
