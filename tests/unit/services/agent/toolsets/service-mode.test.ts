import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ mode: undefined as string | undefined, conversation: {} as Record<string, unknown>, engine: 'halo' }))
const broker = vi.hoisted(() => ({ openToolset: vi.fn(() => ({ ok: true })), closeToolset: vi.fn(() => ({ ok: true })), listToolsetStatuses: vi.fn((_space, _conversation, mode) => [{ mode }]) }))
vi.mock('../../../../../src/main/services/agent/helpers', () => ({ getWorkingDir: () => '/work' }))
vi.mock('../../../../../src/main/services/agent/toolsets/broker', () => broker)
vi.mock('../../../../../src/main/services/agent/toolsets/state', () => ({ getToolsetContextMode: () => state.mode }))
vi.mock('../../../../../src/main/services/agent/toolsets/registry', () => ({ getToolset: (id: string) => ({ id, contextManaged: true }) }))
vi.mock('../../../../../src/main/services/conversation.service', () => ({ getConversation: () => state.conversation }))
vi.mock('../../../../../src/main/services/agent/engine-routing', () => ({ getConversationEngineMetadata: () => state.engine }))
import { listToolsets, openToolsetByUser, closeToolsetByUser } from '../../../../../src/main/services/agent/toolsets/service'

beforeEach(() => {
  state.mode = undefined
  state.conversation = {}
  state.engine = 'halo'
  vi.clearAllMocks()
})

describe('toolset controls follow the native context mode', () => {
  it('shows automatic controls for a fresh Halo conversation and waits for native preparation on resume', () => {
    listToolsets('space', 'conversation')
    expect(broker.listToolsetStatuses).toHaveBeenLastCalledWith('space', 'conversation', 'automatic')
    state.conversation = { sessionId: 'native' }
    listToolsets('space', 'conversation')
    expect(broker.listToolsetStatuses).toHaveBeenLastCalledWith('space', 'conversation', 'pending')
    state.mode = 'manual'
    listToolsets('space', 'conversation')
    expect(broker.listToolsetStatuses).toHaveBeenLastCalledWith('space', 'conversation', 'manual')
  })

  it('uses the captured running mode while another engine selection is pending', () => {
    state.mode = 'automatic'
    state.engine = 'codex'
    listToolsets('space', 'conversation')
    expect(broker.listToolsetStatuses).toHaveBeenLastCalledWith('space', 'conversation', 'automatic')
  })

  it('cannot restore the old context toggle through an old client while automatic', () => {
    expect(openToolsetByUser('space', 'conversation', 'ai-terminal')).toEqual({ ok: true, alreadyOpen: true })
    expect(closeToolsetByUser('space', 'conversation', 'ai-terminal').ok).toBe(false)
    expect(broker.openToolset).not.toHaveBeenCalled()
    expect(broker.closeToolset).not.toHaveBeenCalled()
  })

  it('keeps Halo API available without a grant control', () => {
    expect(openToolsetByUser('space', 'conversation', 'halo-api-ref')).toEqual({ ok: true, alreadyOpen: true })
    expect(closeToolsetByUser('space', 'conversation', 'halo-api-ref').ok).toBe(false)
    expect(broker.openToolset).not.toHaveBeenCalled()
    expect(broker.closeToolset).not.toHaveBeenCalled()
  })

  it.each(['anthropic', 'codex', 'dsh'])('keeps core capabilities available on %s', engine => {
    state.engine = engine
    listToolsets('space', 'conversation')
    expect(broker.listToolsetStatuses).toHaveBeenLastCalledWith('space', 'conversation', 'manual')
    expect(closeToolsetByUser('space', 'conversation', 'ai-terminal').ok).toBe(false)
    expect(broker.closeToolset).not.toHaveBeenCalled()
  })
})
