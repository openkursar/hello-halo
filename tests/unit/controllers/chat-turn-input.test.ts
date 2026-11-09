/**
 * A person's message to a digital human is built field by field at the
 * transport boundary, the same for desktop IPC and remote HTTP: identity is
 * derived from the conversation key, never taken from the body.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

const refs = vi.hoisted(() => ({ store: null as unknown, serviceReady: true }))
vi.mock('../../../src/main/apps/team', () => ({ getTeamStore: () => refs.store, getTeamService: () => refs.serviceReady ? { participants: {} } : null }))

import { parseCanvasContext, toAppChatRequest } from '../../../src/main/controllers/chat-turn-input'
import { resolveAppChatTarget } from '../../../src/main/controllers/app-chat-target.controller'
import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../src/main/apps/team/store'
import { migrations, MIGRATION_NAMESPACE } from '../../../src/main/apps/team/migrations'
import { SELF_NODE_ID, buildTeamSessionKey } from '../../../src/shared/apps/team-types'

beforeEach(() => { refs.store = null; refs.serviceReady = true })

const reference = { id: 'r', source: { kind: 'path', path: '/tmp/a.pdf', isDirectory: false } }

describe('toAppChatRequest', () => {
  it('refuses a source-conversation address before constructing a digital-human chat', () => {
    expect(toAppChatRequest('space-conv-source', { spaceId: '', message: 'hello' })).toMatchObject({
      ok: false, status: 400, error: 'Continue this collaboration in its original conversation.',
    })
    expect(toAppChatRequest('space-conv-source', { spaceId: 'valid-space', message: 'hello' }).ok).toBe(false)
  })
  it('keeps what a client may send and derives the rest', () => {
    const result = toAppChatRequest('app-1', {
      appId: 'someone-else',
      spaceId: 's',
      message: 'hi',
      thinkingEnabled: 1,
      reasoningEffort: 'high',
      references: [reference],
      teamContext: { teamId: 't', epochId: 'e', kind: 'peer_message' },
      senderIdentity: { id: 'x', name: 'Mallory' },
      recorded: { content: 'forged', provenance: { source: 'team-message' } },
      inputRecorded: true, recordedInputIds: ['forged-history-id'],
      humanInput: false, collaborationRequestId: 'forged-request',
      attachedFiles: ['/etc/passwd'],
    })
    expect(result).toEqual({
      ok: true,
      request: {
        appId: 'app-1',
        humanInput: true,
        spaceId: 's',
        message: 'hi',
        conversationId: 'app-chat:app-1',
        thinkingEnabled: true,
        reasoningEffort: 'high',
        references: [reference],
      },
    })
  })

  it('accepts a message of images or references alone, not an empty one', () => {
    const image = { id: 'i', type: 'image', mediaType: 'image/png', data: 'x' }
    expect(toAppChatRequest('app-1', { spaceId: 's', message: '', images: [image] }).ok).toBe(true)
    expect(toAppChatRequest('app-1', { spaceId: 's', message: '', references: [reference] }).ok).toBe(true)
    expect(toAppChatRequest('app-1', { spaceId: 's', message: '' })).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses a malformed request with the status the transport answers', () => {
    expect(toAppChatRequest('app-1', { message: 'hi' })).toMatchObject({ ok: false, status: 400, error: 'Missing required field: spaceId' })
    expect(toAppChatRequest('app-1', { spaceId: 's', message: 'hi', references: [{ id: 1 }] })).toMatchObject({ ok: false, status: 400 })
    expect(toAppChatRequest('app-1', { spaceId: 's', message: 'hi', conversationId: 'app-chat:app-2' })).toMatchObject({ ok: false, status: 400 })
    // A team key needs the team store to vouch for it.
    expect(toAppChatRequest('app-1', { spaceId: 's', message: 'hi', conversationId: 'app-chat:app-1:team:t1:e1' })).toMatchObject({ ok: false, status: 503 })
  })
})

describe('human input to temporary members', () => {
  let db: ReturnType<typeof createDatabaseManager>
  let store: TeamStore
  beforeEach(() => {
    db = createDatabaseManager(':memory:')
    db.runMigrations(db.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db.getAppDatabase())
    refs.store = store
    store.insertTeam({ id: 'team', name: 'Work', owningSpaceId: 'space', goal: '', memberSourcing: 'manual',
      collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null, leadAppId: null, createdAt: 1, updatedAt: 1 })
    for (const id of ['work', 'other-work']) store.insertEpoch({ id, teamId: 'team', startedAt: 1, endedAt: null,
      endReason: null, summary: null, lifecycle: 'conversation' })
    store.participants.insert({ teamId: 'team', epochId: 'work', appId: 'temporary', parentAppId: 'requester', memberName: 'Checker',
      role: 'Review', addedAt: 1, isTemporary: true, isLead: false, aiProvisioned: false, origin: 'local', ownerNodeId: SELF_NODE_ID })
  })
  afterEach(() => db.closeAll())

  it('keeps retained work readable while refusing new input until execution services are ready', () => {
    refs.serviceReady = false
    const conversationId = buildTeamSessionKey('temporary', 'team', 'work')
    expect(resolveAppChatTarget('temporary', conversationId).ok).toBe(true)
    expect(toAppChatRequest('temporary', { spaceId: 'space', conversationId, message: 'Continue' })).toMatchObject({ ok: false, status: 503 })
  })

  it('takes a new recipient fence for fresh human input and keeps the supplied old fence out', () => {
    const target = { teamId: 'team', epochId: 'work', appId: 'temporary' }
    const oldFence = store.recipientFences.read(target)
    const currentFence = store.recipientFences.rotate(target)
    const conversationId = buildTeamSessionKey(target.appId, target.teamId, target.epochId)
    const result = toAppChatRequest(target.appId, { spaceId: 'space', conversationId, message: 'Continue the review.',
      teamContext: { ...target, requestId: 'stopped-request', recipientFence: oldFence } })
    expect(result).toMatchObject({ ok: true, request: { humanInput: true, teamContext: { recipientFence: currentFence } } })
    if (!result.ok) throw new Error(result.error)
    expect(result.request.teamContext?.requestId).not.toBe('stopped-request')
    expect(result.request.teamContext?.requestId).toEqual(expect.any(String))
    const viewed = resolveAppChatTarget(target.appId, conversationId)
    expect(viewed.ok && viewed.teamContext?.recipientFence).toBeUndefined()
  })

  it('refuses a temporary identity outside its own work scope', () => {
    const result = toAppChatRequest('temporary', { spaceId: 'space',
      conversationId: buildTeamSessionKey('temporary', 'team', 'other-work'), message: 'Continue.' })
    expect(result).toMatchObject({ ok: false, status: 403 })
  })
})

describe('parseCanvasContext', () => {
  it('says why it dropped a context, and stays quiet for a closed canvas', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseCanvasContext(undefined)).toBeUndefined()
    expect(parseCanvasContext({ isOpen: false })).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    expect(parseCanvasContext({ isOpen: true, tabCount: 1, activeTab: null, tabs: [{ title: 1 }] })).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[ChatInput] Canvas context dropped: a tab without a string type and title')
    warn.mockRestore()
  })
})
