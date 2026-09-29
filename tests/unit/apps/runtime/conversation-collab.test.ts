/**
 * The decision behind mounting `halo-conversations` on a digital human's turn:
 * the owner's switch (off by default), whose turn it is, and the global settings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ config: {} as Record<string, any> }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => state.config }))

import { resolveConversationCollab } from '../../../../src/main/apps/runtime/conversation-collab'
import { CONVERSATION_COLLAB_PERMISSION, isConversationCollabEnabled } from '../../../../src/shared/apps/app-types'

const appWith = (permissions: { granted?: string[]; denied?: string[] }, specPermissions?: string[]) =>
  ({ id: 'app-1', permissions: { granted: [], denied: [], ...permissions }, spec: { permissions: specPermissions } }) as any

const OWNER = { conversationId: 'app-chat:app-1', delegated: false, team: false }

beforeEach(() => {
  state.config = { agent: {} }
})

describe('the switch', () => {
  it('is off unless someone turns it on', () => {
    expect(isConversationCollabEnabled(appWith({}))).toBe(false)
    expect(resolveConversationCollab(appWith({}), OWNER)).toBeNull()
  })

  it('turns on by the owner\'s grant or by the spec declaring it, and an explicit denial beats both', () => {
    expect(isConversationCollabEnabled(appWith({ granted: [CONVERSATION_COLLAB_PERMISSION] }))).toBe(true)
    expect(isConversationCollabEnabled(appWith({}, [CONVERSATION_COLLAB_PERMISSION]))).toBe(true)
    expect(isConversationCollabEnabled(appWith({ granted: [CONVERSATION_COLLAB_PERMISSION], denied: [CONVERSATION_COLLAB_PERMISSION] }))).toBe(false)
  })
})

describe('resolveConversationCollab', () => {
  const on = appWith({ granted: [CONVERSATION_COLLAB_PERMISSION] })

  it('mounts read and send for the owner', () => {
    expect(resolveConversationCollab(on, OWNER)).toEqual({ includeSend: true })
  })

  it('never mounts on someone else\'s turn, or in a team channel, whatever the switch says', () => {
    expect(resolveConversationCollab(on, { ...OWNER, delegated: true })).toBeNull()
    expect(resolveConversationCollab(on, { ...OWNER, team: true })).toBeNull()
    expect(resolveConversationCollab(on, { ...OWNER, delegated: true, team: true })).toBeNull()
  })

  it('mounts in the default and local sessions only, and only for this digital human', () => {
    const at = (conversationId: string) => resolveConversationCollab(on, { ...OWNER, conversationId })
    expect(at('app-chat:app-1:local:direct:abc')).toEqual({ includeSend: true })
    expect(at('app-chat:app-1:wecom-bot:direct:u1')).toBeNull()
    expect(at('app-chat:app-1:wecom-bot:group:g1')).toBeNull()
    expect(at('app-chat:app-1:http:direct:s1')).toBeNull()
    expect(at('app-chat:app-1:local:group:abc')).toBeNull()
    expect(at('app-chat:app-2:local:direct:abc')).toBeNull()
    expect(at('app-chat:app-1:team:t1:e1')).toBeNull()
  })

  it('mounts for this digital human\'s scheduled runs, under the run\'s own sender key', () => {
    const at = (conversationId: string) => resolveConversationCollab(on, { ...OWNER, conversationId })
    expect(at('app-run:app-1:run-1')).toEqual({ includeSend: true })
    expect(at('app-run:app-2:run-1')).toBeNull()
  })

  it('follows the global master switch', () => {
    state.config = { agent: { enableConversationInterop: false } }
    expect(resolveConversationCollab(on, OWNER)).toBeNull()
  })

  it('narrows to reading when the global send switch is off', () => {
    state.config = { agent: { enableConversationSend: false } }
    expect(resolveConversationCollab(on, OWNER)).toEqual({ includeSend: false })
  })

  it('treats a missing agent config as the defaults', () => {
    state.config = {}
    expect(resolveConversationCollab(on, OWNER)).toEqual({ includeSend: true })
  })
})
