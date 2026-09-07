/**
 * Regression test for the IM front desk's woken turns.
 *
 * A team-backed IM chat is served by ONE bound member, and that member's turns
 * arrive by two different routes: the person's message (dispatch-inbound) and a
 * later teammate reply that wakes it (this file's session deps). Both land on
 * the SAME session key.
 *
 * The bug this pins: the woken route resolved the chat's framing but not its
 * file-send capability, so the two routes handed app-chat different tool sets.
 * A session is rebuilt whenever its tool set changes, and a rebuild during a
 * turn's start-up settles that turn's round as failed — so the woken turn threw
 * before it could push anything, and the person waiting in the chat never got
 * the teammate's answer. Nothing logged an error the user could see: the model
 * even produced the reply, on a session whose caller had already given up.
 *
 * The invariant, therefore: for one chat, both routes resolve the IM route in
 * full or not at all.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { channel, appChatCalls } = vi.hoisted(() => ({
  channel: {
    config: undefined as Record<string, unknown> | undefined,
    instance: undefined as Record<string, unknown> | undefined,
  },
  appChatCalls: [] as Record<string, unknown>[],
}))

vi.mock('../../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: () => false,
  injectIntoAppChat: () => true,
}))

vi.mock('../../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: () => ({ spaceId: 'space-1' }) }),
}))

vi.mock('../../../../../src/main/services/space.service', () => ({
  getSpaceDir: () => '/tmp/space-1',
}))

vi.mock('../../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => ({
    getInstanceConfig: () => channel.config,
    getInstance: () => channel.instance,
  }),
}))

vi.mock('../../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => null,
}))

vi.mock('../../../../../src/main/apps/runtime/app-chat', () => ({
  sendAppChatMessage: async (request: Record<string, unknown>) => {
    appChatCalls.push(request)
    ;(request.onReply as ((s: string) => void) | undefined)?.('answer for the person')
  },
}))

import { createDefaultSessionDeps } from '../../../../../src/main/apps/runtime/team'
import type { TeamStore } from '../../../../../src/main/apps/team'

const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const MEMBER_APP_ID = 'member-app'
const INSTANCE_ID = 'inst-1'
const CHAT_ID = 'chat-9'
const SESSION_KEY = `app-chat:${MEMBER_APP_ID}:team:${TEAM_ID}:${EPOCH_ID}`

/** A store whose epoch is the IM conversation of CHAT_ID, unless overridden. */
function storeWithEpoch(chatKey: string | null = `${INSTANCE_ID}:direct:${CHAT_ID}`): TeamStore {
  return {
    getEpochById: () => ({
      id: EPOCH_ID,
      teamId: TEAM_ID,
      lifecycle: 'conversation',
      chatKey,
    }),
  } as unknown as TeamStore
}

const pushToChat = vi.fn(() => true)

function wake(store: TeamStore) {
  return createDefaultSessionDeps(store).sendAppChatMessage({
    appId: MEMBER_APP_ID,
    spaceId: 'space-1',
    message: '[Team message from Lead] ...',
    conversationId: SESSION_KEY,
    teamContext: { teamId: TEAM_ID, epochId: EPOCH_ID, correlationId: 'c1', fromAppId: 'lead-app', wait: false },
  })
}

beforeEach(() => {
  appChatCalls.length = 0
  pushToChat.mockClear()
  channel.config = { id: INSTANCE_ID, teamId: TEAM_ID, appId: MEMBER_APP_ID }
  channel.instance = {
    providerType: 'wecom-bot',
    pushToChat,
    fileCapability: { sendFile: vi.fn(async () => true) },
  }
})

describe('woken front-desk turn — the IM route is resolved in full', () => {
  it('carries the chat file-send capability, not just the framing', async () => {
    await wake(storeWithEpoch())

    const request = appChatCalls[0]
    expect(request.imSession).toMatchObject({ channel: 'wecom-bot', chatType: 'direct' })
    // The half that was missing. Its ABSENCE is what changed the tool set
    // between the two routes and destroyed the turn.
    expect(typeof request.imFileSend).toBe('function')
  })

  it('pushes the reply back to that chat', async () => {
    const result = await wake(storeWithEpoch())

    expect(result.finalMessage).toBe('answer for the person')
    expect(pushToChat).toHaveBeenCalledWith(CHAT_ID, 'answer for the person', 'direct')
  })

  it('leaves file send undefined for a text-only channel — the same answer the inbound route gives', async () => {
    channel.instance = { providerType: 'wecom-bot', pushToChat }

    await wake(storeWithEpoch())

    const request = appChatCalls[0]
    expect(request.imSession).toBeDefined()
    expect(request.imFileSend).toBeUndefined()
  })
})

describe('woken turns that are NOT the front desk stay internal', () => {
  it('resolves nothing when the instance binds a different member', async () => {
    channel.config = { id: INSTANCE_ID, teamId: TEAM_ID, appId: 'someone-else' }

    await wake(storeWithEpoch())

    const request = appChatCalls[0]
    expect(request.imSession).toBeUndefined()
    expect(request.imFileSend).toBeUndefined()
    expect(pushToChat).not.toHaveBeenCalled()
  })

  it('resolves nothing for a native team conversation', async () => {
    await wake(storeWithEpoch('native:9f21ac'))

    const request = appChatCalls[0]
    expect(request.imSession).toBeUndefined()
    expect(request.imFileSend).toBeUndefined()
    expect(pushToChat).not.toHaveBeenCalled()
  })
})
